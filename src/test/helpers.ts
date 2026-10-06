import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MergeModel, ResultEdit } from '../merge/MergeModel';

/** Minimal stand-in for the VS Code result document: applies edits and reports them back to the model. */
export class FakeResultDocument {
    private readonly undoStack: ResultEdit[][] = [];

    constructor(readonly model: MergeModel, public text = model.initialResult) {}

    apply(edits: ResultEdit | ResultEdit[] | undefined, recordUndo = true): void {
        const list = (Array.isArray(edits) ? edits : edits ? [edits] : []).sort((a, b) => b.start - a.start);
        if (list.length === 0) {
            return;
        }
        // Inverse edits are expressed in post-edit offsets: shift each by the size change of the edits before it.
        const inverse: ResultEdit[] = [];
        let delta = 0;
        for (const e of [...list].reverse()) {
            inverse.push({ start: e.start + delta, end: e.start + delta + e.text.length, text: this.text.slice(e.start, e.end) });
            delta += e.text.length - (e.end - e.start);
        }
        for (const e of list) {
            this.text = this.text.slice(0, e.start) + e.text + this.text.slice(e.end);
        }
        if (recordUndo) {
            this.undoStack.push(inverse);
        }
        this.model.handleDocumentChange(
            list.map(e => ({ rangeOffset: e.start, rangeLength: e.end - e.start, text: e.text })),
            (s, end) => this.text.slice(s, end),
        );
    }

    /** Simulates the user typing/replacing `find` with `replacement`. */
    type(find: string, replacement: string): void {
        const start = this.text.indexOf(find);
        if (start < 0) {
            throw new Error(`"${find}" not found in result`);
        }
        this.apply({ start, end: start + find.length, text: replacement });
    }

    undo(): void {
        const inverse = this.undoStack.pop();
        if (inverse) {
            this.apply(inverse, false);
        }
    }
}

export function lines(...items: string[]): string {
    return items.map(l => l + '\n').join('');
}

export function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Creates a temporary repository with `file` conflicting between main and a feature branch. */
export function createConflictRepo(files: Record<string, { base?: string; ours?: string | null; theirs?: string | null }>): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'merge-resolver-test-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'commit.gpgsign', 'false');

    const write = (name: string, content: string | null | undefined) => {
        const file = path.join(dir, name);
        if (content === null) {
            fs.rmSync(file, { force: true });
        } else if (content !== undefined) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content);
        }
    };

    fs.writeFileSync(path.join(dir, '.keep'), '');
    for (const [name, v] of Object.entries(files)) {
        write(name, v.base);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');

    git(dir, 'checkout', '-q', '-b', 'feature');
    for (const [name, v] of Object.entries(files)) {
        write(name, v.theirs);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'theirs', '--allow-empty');

    git(dir, 'checkout', '-q', 'main');
    for (const [name, v] of Object.entries(files)) {
        write(name, v.ours);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'ours', '--allow-empty');

    try {
        git(dir, 'merge', '-q', 'feature');
    } catch {
        // expected: conflicts
    }
    return dir;
}

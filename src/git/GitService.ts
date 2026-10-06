import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export class GitError extends Error {
    constructor(message: string, readonly stderr: string) {
        super(message);
    }
}

export type MergeOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'none';

export interface MergeStatus {
    operation: MergeOperation;
    oursLabel: string;
    theirsLabel: string;
}

/** Index stages present for an unmerged path: 1 = base, 2 = ours, 3 = theirs. */
export interface ConflictedFile {
    relativePath: string;
    absolutePath: string;
    stages: Set<1 | 2 | 3>;
}

export type ConflictType =
    | 'both-modified'
    | 'both-added'
    | 'deleted-by-them'
    | 'deleted-by-us'
    | 'both-deleted'
    | 'added-by-us'
    | 'added-by-them';

export interface FileVersion {
    content: Buffer;
    binary: boolean;
}

const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Thin wrapper around the git CLI for one repository. All Git access in the extension goes through here.
 * Uses execFile (no shell), so paths are never interpreted by a shell.
 */
export class GitService {
    private constructor(readonly root: string) {}

    private static readonly instances = new Map<string, GitService>();

    /** Finds the repository containing `fsPath` and the path relative to its root (as Git sees it). */
    static async forFile(fsPath: string): Promise<{ git: GitService; relativePath: string }> {
        const dir = path.dirname(fsPath);
        const [root, prefix] = (await run(dir, ['rev-parse', '--show-toplevel', '--show-prefix'])).toString('utf8').split('\n');
        const relativePath = (prefix + path.basename(fsPath)).split(path.sep).join('/');
        return { git: GitService.forRoot(root), relativePath };
    }

    static forRoot(root: string): GitService {
        let instance = GitService.instances.get(root);
        if (!instance) {
            instance = new GitService(root);
            GitService.instances.set(root, instance);
        }
        return instance;
    }

    async getConflictedFiles(): Promise<ConflictedFile[]> {
        const out = (await this.git(['ls-files', '-u', '-z'])).toString('utf8');
        const files = new Map<string, ConflictedFile>();
        for (const entry of out.split('\0')) {
            const match = /^\d+ [0-9a-f]+ ([123])\t(.*)$/s.exec(entry);
            if (!match) {
                continue;
            }
            const relativePath = match[2];
            let file = files.get(relativePath);
            if (!file) {
                file = { relativePath, absolutePath: path.join(this.root, relativePath), stages: new Set() };
                files.set(relativePath, file);
            }
            file.stages.add(Number(match[1]) as 1 | 2 | 3);
        }
        return [...files.values()];
    }

    async getConflict(relativePath: string): Promise<ConflictedFile | undefined> {
        return (await this.getConflictedFiles()).find(f => f.relativePath === relativePath);
    }

    getBaseVersion(relativePath: string): Promise<FileVersion | undefined> {
        return this.getStage(relativePath, 1);
    }

    getOursVersion(relativePath: string): Promise<FileVersion | undefined> {
        return this.getStage(relativePath, 2);
    }

    getTheirsVersion(relativePath: string): Promise<FileVersion | undefined> {
        return this.getStage(relativePath, 3);
    }

    async getWorkingVersion(relativePath: string): Promise<FileVersion | undefined> {
        try {
            const content = await fs.readFile(path.join(this.root, relativePath));
            return { content, binary: isBinary(content) };
        } catch {
            return undefined;
        }
    }

    async getMergeStatus(): Promise<MergeStatus> {
        const gitDir = (await this.git(['rev-parse', '--absolute-git-dir'])).toString('utf8').trim();
        const exists = (name: string) => fs.stat(path.join(gitDir, name)).then(() => true, () => false);
        const head = await this.describe('HEAD');

        if (await exists('rebase-merge') || await exists('rebase-apply')) {
            // During a rebase, "ours" is the branch being rebased onto and "theirs" is the commit being replayed.
            const onto = await this.readFirstLine(path.join(gitDir, 'rebase-merge', 'onto'));
            return { operation: 'rebase', oursLabel: onto ? await this.describe(onto) : head, theirsLabel: await this.describe('REBASE_HEAD') };
        }
        if (await exists('MERGE_HEAD')) {
            return { operation: 'merge', oursLabel: head, theirsLabel: await this.describe('MERGE_HEAD') };
        }
        if (await exists('CHERRY_PICK_HEAD')) {
            return { operation: 'cherry-pick', oursLabel: head, theirsLabel: await this.describe('CHERRY_PICK_HEAD') };
        }
        if (await exists('REVERT_HEAD')) {
            return { operation: 'revert', oursLabel: head, theirsLabel: await this.describe('REVERT_HEAD') };
        }
        return { operation: 'none', oursLabel: head, theirsLabel: 'incoming' };
    }

    /** Marks the file as resolved in the index (`git add`). Never commits. */
    async markResolved(relativePath: string): Promise<void> {
        await this.git(['add', '--', relativePath]);
    }

    /** Resolves a conflict by removing the file (`git rm`). */
    async removeFile(relativePath: string): Promise<void> {
        await this.git(['rm', '--quiet', '--', relativePath]);
    }

    /** Replaces the working file with one side's version and marks it resolved. Overwrites the working file. */
    async checkoutSide(relativePath: string, side: 'ours' | 'theirs'): Promise<void> {
        await this.git(['checkout', `--${side}`, '--', relativePath]);
        await this.markResolved(relativePath);
    }

    /** Aborts the in-progress operation. Destructive: callers must obtain explicit user confirmation first. */
    async abort(operation: Exclude<MergeOperation, 'none'>): Promise<void> {
        await this.git([operation, '--abort']);
    }

    private async getStage(relativePath: string, stage: 1 | 2 | 3): Promise<FileVersion | undefined> {
        try {
            const content = await this.git(['cat-file', 'blob', `:${stage}:${relativePath}`]);
            return { content, binary: isBinary(content) };
        } catch {
            return undefined; // stage absent (e.g. file added or deleted on one side)
        }
    }

    private async describe(ref: string): Promise<string> {
        try {
            const name = (await this.git(['rev-parse', '--abbrev-ref', ref])).toString('utf8').trim();
            if (name && name !== ref && name !== 'HEAD') {
                return name;
            }
        } catch {
            // fall through
        }
        try {
            const name = (await this.git(['name-rev', '--name-only', '--no-undefined', '--exclude=refs/tags/*', ref])).toString('utf8').trim();
            if (name) {
                return name.replace(/~\d+$/, '');
            }
        } catch {
            // fall through
        }
        try {
            return (await this.git(['rev-parse', '--short', ref])).toString('utf8').trim();
        } catch {
            return ref;
        }
    }

    private async readFirstLine(file: string): Promise<string | undefined> {
        try {
            return (await fs.readFile(file, 'utf8')).split('\n')[0].trim() || undefined;
        } catch {
            return undefined;
        }
    }

    private git(args: string[]): Promise<Buffer> {
        return run(this.root, args);
    }
}

export function classifyConflict(stages: Set<1 | 2 | 3>): ConflictType {
    const base = stages.has(1);
    const ours = stages.has(2);
    const theirs = stages.has(3);
    if (ours && theirs) {
        return base ? 'both-modified' : 'both-added';
    }
    if (ours) {
        return base ? 'deleted-by-them' : 'added-by-us';
    }
    if (theirs) {
        return base ? 'deleted-by-us' : 'added-by-them';
    }
    return 'both-deleted';
}

/** Same heuristic as Git: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(content: Buffer): boolean {
    return content.subarray(0, 8000).includes(0);
}

/** Decodes a Git blob as UTF-8 (a leading BOM is dropped). */
export function decodeText(content: Buffer): string {
    return new TextDecoder('utf-8').decode(content);
}

function run(cwd: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
            if (error) {
                const message = stderr.toString('utf8').trim() || error.message;
                reject(new GitError(`git ${args[0]} failed: ${message}`, stderr.toString('utf8')));
            } else {
                resolve(stdout);
            }
        });
    });
}

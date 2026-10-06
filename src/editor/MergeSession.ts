import * as path from 'path';
import * as vscode from 'vscode';
import { GitService, MergeStatus } from '../git/GitService';
import { MergeChunk, Side } from '../merge/MergeChunk';
import { MergeModel, ResultEdit } from '../merge/MergeModel';
import { Highlight, HighlightStyle, MergeDecorations } from './decorations';
import { resultUri, ResultFileSystem, Revision, RevisionContentProvider, revisionUri } from './documents';

export type PaneRole = 'ours' | 'result' | 'theirs';

export interface SessionServices {
    revisions: RevisionContentProvider;
    results: ResultFileSystem;
    decorations: MergeDecorations;
}

export interface SessionSource {
    fileUri: vscode.Uri;
    git: GitService | undefined;
    relativePath: string;
    model: MergeModel;
    labels: MergeStatus;
    languageId: string;
    /** Content of the working file when the session started; used to detect concurrent changes before writing. */
    workingSnapshot: string | undefined;
}

const SCROLL_ECHO_MS = 200;

/**
 * One three-pane merge of one file: Yours (read-only) | Result (editable) | Theirs (read-only).
 * The panes are ordinary VS Code text editors placed in three side-by-side editor groups.
 */
export class MergeSession implements vscode.Disposable {
    readonly uris: Record<PaneRole | 'base', vscode.Uri>;
    readonly fileName: string;
    /** The chunk most recently navigated to; the target of commands invoked without a cursor inside a chunk. */
    currentChunkId: number | undefined;
    /** Set once all three panes have been opened. */
    ready = false;
    closing = false;

    private readonly scrollEcho = new Map<string, number>();

    constructor(readonly id: string, readonly source: SessionSource, private readonly services: SessionServices) {
        this.fileName = path.basename(source.fileUri.fsPath);
        this.uris = {
            ours: revisionUri(id, 'ours', `${this.fileName} (Yours)`),
            theirs: revisionUri(id, 'theirs', `${this.fileName} (Theirs)`),
            base: revisionUri(id, 'base', `${this.fileName} (Base)`),
            result: resultUri(id, `${this.fileName} (Result)`),
        };
        const { model } = source;
        const revisions: Record<Revision, string> = { ours: model.ours, theirs: model.theirs, base: model.base };
        for (const rev of ['ours', 'theirs', 'base'] as const) {
            services.revisions.set(this.uris[rev], revisions[rev]);
        }
        services.results.setContent(this.uris.result, model.initialResult);
    }

    get model(): MergeModel {
        return this.source.model;
    }

    /** Lays out three side-by-side editor groups and opens Yours | Result | Theirs. */
    async show(): Promise<void> {
        if (vscode.window.tabGroups.all.length < 3) {
            await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}, {}, {}] });
        }
        const open = async (role: PaneRole, viewColumn: vscode.ViewColumn, preserveFocus: boolean) => {
            let doc = await vscode.workspace.openTextDocument(this.uris[role]);
            if (doc.languageId !== this.source.languageId) {
                doc = await vscode.languages.setTextDocumentLanguage(doc, this.source.languageId);
            }
            return vscode.window.showTextDocument(doc, { viewColumn, preserveFocus, preview: false });
        };
        await open('ours', vscode.ViewColumn.One, true);
        await open('theirs', vscode.ViewColumn.Three, true);
        const resultDoc = await vscode.workspace.openTextDocument(this.uris.result);
        if (!this.ready && resultDoc.getText() !== this.model.initialResult) {
            // Offsets in the model would not match the editor (e.g. a non-UTF-8 `files.encoding` setting).
            throw new Error('The Result document could not be initialized (unexpected text decoding).');
        }
        await open('result', vscode.ViewColumn.Two, false);
        this.ready = true;
        this.render();
    }

    roleOf(uri: vscode.Uri): PaneRole | 'base' | undefined {
        const key = uri.toString();
        return (Object.keys(this.uris) as (PaneRole | 'base')[]).find(role => this.uris[role].toString() === key);
    }

    owns(uri: vscode.Uri): boolean {
        return this.roleOf(uri) !== undefined;
    }

    get resultDocument(): vscode.TextDocument | undefined {
        const key = this.uris.result.toString();
        return vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
    }

    visibleEditors(role: PaneRole): vscode.TextEditor[] {
        const key = this.uris[role].toString();
        return vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === key);
    }

    resultText(): string {
        return this.resultDocument?.getText() ?? this.model.initialResult;
    }

    regionText(chunk: MergeChunk): string {
        const doc = this.resultDocument;
        return doc ? doc.getText(new vscode.Range(doc.positionAt(chunk.start), doc.positionAt(chunk.end))) : chunk.baseText;
    }

    /** Applies model edits to the Result as a single undoable step. */
    async applyEdits(edits: readonly (ResultEdit | undefined)[]): Promise<boolean> {
        const doc = this.resultDocument;
        const list = edits.filter((e): e is ResultEdit => e !== undefined);
        if (!doc || list.length === 0) {
            return list.length === 0;
        }
        const edit = new vscode.WorkspaceEdit();
        for (const e of list) {
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
        }
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            // Bring the model back in line with whatever the document now contains.
            this.model.chunks.forEach(c => c.syncWithText(this.regionText(c)));
        }
        return applied;
    }

    handleResultChange(event: vscode.TextDocumentChangeEvent): void {
        const doc = event.document;
        this.model.handleDocumentChange(event.contentChanges, (start, end) =>
            doc.getText(new vscode.Range(doc.positionAt(start), doc.positionAt(end))));
    }

    /** Line range of a chunk inside the given pane. */
    chunkLines(chunk: MergeChunk, role: PaneRole): { start: number; end: number } {
        if (role !== 'result') {
            return chunk.sideLines(role);
        }
        const doc = this.resultDocument;
        if (!doc) {
            return chunk.baseLines;
        }
        const start = doc.positionAt(chunk.start).line;
        const endPos = doc.positionAt(chunk.end);
        return { start, end: chunk.end === chunk.start ? start : endPos.character > 0 ? endPos.line + 1 : endPos.line };
    }

    /** The chunk under the cursor of the given editor (if it belongs to this session). */
    chunkAtCursor(editor: vscode.TextEditor): MergeChunk | undefined {
        const role = this.roleOf(editor.document.uri);
        const line = editor.selection.active.line;
        if (role === 'ours' || role === 'theirs' || role === 'base') {
            return this.model.chunkAtLine(role, line);
        }
        if (role === 'result') {
            const matches = this.model.chunks.filter(c => {
                const r = this.chunkLines(c, 'result');
                return (r.start <= line && line < r.end) || (r.start === r.end && r.start === line);
            });
            return matches.find(c => c.end > c.start) ?? matches[0];
        }
        return undefined;
    }

    /** Moves all three panes to the chunk and selects its start in the Result. */
    reveal(chunk: MergeChunk): void {
        this.currentChunkId = chunk.id;
        for (const role of ['ours', 'theirs', 'result'] as const) {
            const lines = this.chunkLines(chunk, role);
            for (const editor of this.visibleEditors(role)) {
                const range = new vscode.Range(lines.start, 0, Math.max(lines.start, lines.end - 1), 0);
                if (role === 'result') {
                    editor.selection = new vscode.Selection(range.start, range.start);
                } else {
                    this.scrollEcho.set(editor.document.uri.toString(), Date.now());
                }
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
        }
    }

    /** Keeps the other panes aligned with the one the user scrolls, mapping lines through the chunk boundaries. */
    syncScroll(source: vscode.TextEditor): void {
        const sourceRole = this.roleOf(source.document.uri);
        const key = source.document.uri.toString();
        if (!sourceRole || sourceRole === 'base' || source.visibleRanges.length === 0) {
            return;
        }
        if (Date.now() - (this.scrollEcho.get(key) ?? 0) < SCROLL_ECHO_MS) {
            return; // this scroll was caused by us
        }
        const topLine = source.visibleRanges[0].start.line;
        for (const role of ['ours', 'result', 'theirs'] as const) {
            if (role === sourceRole) {
                continue;
            }
            const line = this.mapLine(topLine, sourceRole, role);
            for (const editor of this.visibleEditors(role)) {
                if (editor.visibleRanges[0]?.start.line !== line) {
                    this.scrollEcho.set(editor.document.uri.toString(), Date.now());
                    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
                }
            }
        }
    }

    private mapLine(line: number, from: PaneRole, to: PaneRole): number {
        // Breakpoints at every chunk boundary; between them lines map linearly (1:1 in unchanged stretches).
        let fromPrev = 0;
        let toPrev = 0;
        for (const chunk of this.model.chunks) {
            const a = this.chunkLines(chunk, from);
            const b = this.chunkLines(chunk, to);
            if (line < a.start) {
                return toPrev + Math.min(line - fromPrev, b.start - toPrev);
            }
            if (line < a.end) {
                const ratio = (b.end - b.start) / (a.end - a.start);
                return b.start + Math.floor((line - a.start) * ratio);
            }
            fromPrev = a.end;
            toPrev = b.end;
        }
        return toPrev + (line - fromPrev);
    }

    /** Re-applies decorations to all visible panes. */
    render(): void {
        for (const role of ['ours', 'result', 'theirs'] as const) {
            const highlights = this.highlights(role);
            for (const editor of this.visibleEditors(role)) {
                this.services.decorations.apply(editor, highlights);
            }
        }
    }

    private highlights(role: PaneRole): Highlight[] {
        const result: Highlight[] = [];
        for (const chunk of this.model.chunks) {
            let style: HighlightStyle | undefined;
            if (role === 'result') {
                style = chunk.resolved ? 'resolved' : chunk.isConflict ? 'conflict' : shapeStyle(chunk, chunk.kind === 'theirs' ? 'theirs' : 'ours');
            } else {
                const state = chunk.state(role);
                if (state === 'none') {
                    continue; // this side did not change the region
                }
                style = state !== 'pending' || chunk.edited ? 'resolved' : chunk.isConflict ? 'conflict' : shapeStyle(chunk, role);
            }
            const lines = this.chunkLines(chunk, role);
            result.push({ style, startLine: lines.start, endLine: lines.end });
        }
        return result;
    }

    dispose(): void {
        this.closing = true;
        for (const rev of ['ours', 'theirs', 'base'] as const) {
            this.services.revisions.delete(this.uris[rev]);
        }
        this.services.results.removeContent(this.uris.result);
        for (const editor of vscode.window.visibleTextEditors.filter(e => this.owns(e.document.uri))) {
            this.services.decorations.apply(editor, []);
        }
    }
}

/** How a side's change relates to base: lines added, deleted, or modified. */
function shapeStyle(chunk: MergeChunk, side: Side): HighlightStyle {
    const base = chunk.baseLines;
    const own = chunk.sideLines(side);
    if (base.end === base.start) {
        return 'added';
    }
    return own.end === own.start ? 'deleted' : 'modified';
}

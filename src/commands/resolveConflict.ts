import * as vscode from 'vscode';
import { MergeChunk, Side } from '../merge/MergeChunk';
import { ApplyFilter } from '../merge/MergeModel';
import { MergeSession, PaneRole } from '../editor/MergeSession';
import { SessionManager } from '../editor/SessionManager';

interface Target {
    session: MergeSession;
    chunk: MergeChunk;
}

/** Session from a CodeLens/toolbar argument (session id) or from the active editor. */
export function sessionFromArgs(sessions: SessionManager, sessionId: unknown): MergeSession | undefined {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : sessions.active();
    if (!session) {
        void vscode.window.showWarningMessage('Merge Resolver: open a conflicted file in the merge resolver first.');
    }
    return session;
}

/** Chunk from CodeLens arguments, else the chunk under the cursor, else the last navigated chunk. */
function targetFromArgs(sessions: SessionManager, sessionId: unknown, chunkId: unknown): Target | undefined {
    const session = sessionFromArgs(sessions, typeof chunkId === 'number' ? sessionId : undefined);
    if (!session) {
        return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    const chunk = typeof chunkId === 'number' ? session.model.chunk(chunkId)
        : (editor && session.owns(editor.document.uri) ? session.chunkAtCursor(editor) : undefined)
            ?? (session.currentChunkId !== undefined ? session.model.chunk(session.currentChunkId) : undefined);
    if (!chunk) {
        void vscode.window.showInformationMessage('Merge Resolver: place the cursor inside a change or conflict first.');
        return undefined;
    }
    return { session, chunk };
}

async function run(sessions: SessionManager, target: Target | undefined, action: (t: Target) => Promise<unknown> | unknown): Promise<void> {
    if (!target) {
        return;
    }
    target.session.currentChunkId = target.chunk.id;
    await action(target);
    sessions.scheduleRefresh();
}

export type RegisterCommand = (id: string, handler: (...args: any[]) => unknown) => vscode.Disposable;

export function registerResolveCommands(sessions: SessionManager, register: RegisterCommand): vscode.Disposable[] {
    const accept = (side: Side) => (sessionId?: unknown, chunkId?: unknown) =>
        run(sessions, targetFromArgs(sessions, sessionId, chunkId), ({ session, chunk }) => session.applyEdits([session.model.accept(chunk, side)]));
    const ignore = (side: Side) => (sessionId?: unknown, chunkId?: unknown) =>
        run(sessions, targetFromArgs(sessions, sessionId, chunkId), ({ session, chunk }) => session.model.ignore(chunk, side, session.regionText(chunk)));
    const applyNonConflicting = (filter: ApplyFilter) => async (sessionId?: unknown) => {
        const session = sessionFromArgs(sessions, sessionId);
        if (session) {
            const edits = session.model.applyNonConflicting(filter);
            if (edits.length === 0) {
                void vscode.window.showInformationMessage('Merge Resolver: no pending non-conflicting changes.');
            }
            await session.applyEdits(edits);
            sessions.scheduleRefresh();
        }
    };

    return [
        register('phpstorm-merge.acceptYours', accept('ours')),
        register('phpstorm-merge.acceptTheirs', accept('theirs')),
        register('phpstorm-merge.ignoreYours', ignore('ours')),
        register('phpstorm-merge.ignoreTheirs', ignore('theirs')),
        register('phpstorm-merge.acceptBoth', (sessionId?: unknown, chunkId?: unknown) =>
            run(sessions, targetFromArgs(sessions, sessionId, chunkId), ({ session, chunk }) => session.applyEdits([session.model.acceptBoth(chunk)]))),
        register('phpstorm-merge.resolveSimple', (sessionId?: unknown, chunkId?: unknown) =>
            run(sessions, targetFromArgs(sessions, sessionId, chunkId), async ({ session, chunk }) => {
                const edit = session.model.resolveSimple(chunk);
                if (!edit) {
                    void vscode.window.showInformationMessage('This conflict cannot be resolved automatically: both sides changed the same text.');
                    return;
                }
                await session.applyEdits([edit]);
            })),
        register('phpstorm-merge.revertResolution', (sessionId?: unknown, chunkId?: unknown) =>
            run(sessions, targetFromArgs(sessions, sessionId, chunkId), ({ session, chunk }) => session.applyEdits([session.model.revert(chunk)]))),
        register('phpstorm-merge.applyNonConflicting', applyNonConflicting('all')),
        register('phpstorm-merge.applyNonConflictingYours', applyNonConflicting('ours')),
        register('phpstorm-merge.applyNonConflictingTheirs', applyNonConflicting('theirs')),
        register('phpstorm-merge.nextConflict', (sessionId?: unknown) => navigate(sessions, sessionId, 1)),
        register('phpstorm-merge.previousConflict', (sessionId?: unknown) => navigate(sessions, sessionId, -1)),
        register('phpstorm-merge.compare', (sessionId?: unknown) => compare(sessions, sessionId)),
    ];
}

/** Jumps to the next/previous unresolved conflict (or pending change once all conflicts are resolved), wrapping around. */
function navigate(sessions: SessionManager, sessionId: unknown, direction: 1 | -1): void {
    const session = sessionFromArgs(sessions, sessionId);
    if (!session) {
        return;
    }
    const conflicts = session.model.chunks.filter(c => c.isConflict && !c.resolved);
    const candidates = conflicts.length > 0 ? conflicts : session.model.chunks.filter(c => !c.resolved);
    if (candidates.length === 0) {
        void vscode.window.showInformationMessage('All conflicts resolved.', 'Complete Merge')
            .then(choice => choice && vscode.commands.executeCommand('phpstorm-merge.completeMerge', session.id));
        return;
    }
    const editor = vscode.window.activeTextEditor;
    const editorRole = editor && session.roleOf(editor.document.uri);
    const inPane = editorRole !== undefined && editorRole !== 'base';
    const role: PaneRole = inPane ? editorRole : 'result';
    const line = inPane && editor ? editor.selection.active.line : -1;
    const startOf = (c: MergeChunk) => session.chunkLines(c, role).start;
    const target = direction === 1
        ? candidates.find(c => startOf(c) > line) ?? candidates[0]
        : [...candidates].reverse().find(c => startOf(c) < line) ?? candidates[candidates.length - 1];
    session.reveal(target);
    sessions.scheduleRefresh();
}

const COMPARISONS = [
    { label: 'Compare Yours with Theirs', left: 'ours', right: 'theirs' },
    { label: 'Compare Yours with Base', left: 'base', right: 'ours' },
    { label: 'Compare Theirs with Base', left: 'base', right: 'theirs' },
    { label: 'Compare Result with Yours', left: 'ours', right: 'result' },
    { label: 'Compare Result with Theirs', left: 'theirs', right: 'result' },
    { label: 'Compare Result with Base', left: 'base', right: 'result' },
] as const;

export type ComparisonId = `${typeof COMPARISONS[number]['left']}-${typeof COMPARISONS[number]['right']}`;

/** Opens VS Code's own diff editor for any two of Base / Yours / Theirs / Result. */
export async function compare(sessions: SessionManager, sessionId: unknown, which?: ComparisonId): Promise<void> {
    const session = sessionFromArgs(sessions, sessionId);
    if (!session) {
        return;
    }
    const picked = which
        ? COMPARISONS.find(c => `${c.left}-${c.right}` === which)
        : await vscode.window.showQuickPick(COMPARISONS.map(c => ({ ...c })), { placeHolder: `Compare versions of ${session.fileName}` });
    if (!picked) {
        return;
    }
    const name = (role: typeof picked.left | typeof picked.right) => role === 'ours' ? 'Yours' : role === 'theirs' ? 'Theirs' : role === 'base' ? 'Base' : 'Result';
    await vscode.commands.executeCommand('vscode.diff', session.uris[picked.left], session.uris[picked.right],
        `${session.fileName}: ${name(picked.left)} ↔ ${name(picked.right)}`, { preview: true });
}

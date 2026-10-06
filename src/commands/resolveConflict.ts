import * as vscode from 'vscode';
import { MergeSession } from '../editor/MergeSession';
import { SessionManager } from '../editor/SessionManager';
import type { ComparisonId, MergeAction } from '../shared/protocol';

export type { ComparisonId } from '../shared/protocol';

/** Session from a command argument (session id) or the focused merge editor. */
export function sessionFromArgs(sessions: SessionManager, sessionId: unknown): MergeSession | undefined {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : sessions.active();
    if (!session) {
        void vscode.window.showWarningMessage('Merge Resolver: open a conflicted file in the merge resolver first.');
    }
    return session;
}

export type RegisterCommand = (id: string, handler: (...args: any[]) => unknown) => vscode.Disposable;

const ACTIONS: Record<string, MergeAction> = {
    'phpstorm-merge.acceptYours': 'acceptYours',
    'phpstorm-merge.acceptTheirs': 'acceptTheirs',
    'phpstorm-merge.ignoreYours': 'ignoreYours',
    'phpstorm-merge.ignoreTheirs': 'ignoreTheirs',
    'phpstorm-merge.acceptBoth': 'acceptBoth',
    'phpstorm-merge.resolveSimple': 'resolveSimple',
    'phpstorm-merge.resolveAllSimple': 'resolveAllSimple',
    'phpstorm-merge.revertResolution': 'revertResolution',
    'phpstorm-merge.applyNonConflicting': 'applyNonConflicting',
    'phpstorm-merge.applyNonConflictingYours': 'applyNonConflictingYours',
    'phpstorm-merge.applyNonConflictingTheirs': 'applyNonConflictingTheirs',
    'phpstorm-merge.nextConflict': 'nextConflict',
    'phpstorm-merge.previousConflict': 'previousConflict',
};

/**
 * Commands that act on the merge editor. They run in the webview, on the chunk given as argument or the chunk at the
 * cursor. Arguments (optional): session id, chunk id.
 */
export function registerResolveCommands(sessions: SessionManager, register: RegisterCommand): vscode.Disposable[] {
    return [
        ...Object.entries(ACTIONS).map(([id, action]) => register(id, async (sessionId?: unknown, chunkId?: unknown) => {
            const session = sessionFromArgs(sessions, sessionId);
            if (session) {
                const reply = await session.request(action, { chunkId: typeof chunkId === 'number' ? chunkId : undefined });
                if (reply.error) {
                    void vscode.window.showInformationMessage(`Merge Resolver: ${reply.error}`);
                }
            }
        })),
        register('phpstorm-merge.compare', (sessionId?: unknown) => compare(sessions, sessionId)),
    ];
}

const COMPARISONS: { id: ComparisonId; label: string }[] = [
    { id: 'ours-theirs', label: 'Compare Yours with Theirs' },
    { id: 'base-ours', label: 'Compare Yours with Base' },
    { id: 'base-theirs', label: 'Compare Theirs with Base' },
    { id: 'ours-result', label: 'Compare Result with Yours' },
    { id: 'theirs-result', label: 'Compare Result with Theirs' },
    { id: 'base-result', label: 'Compare Result with Base' },
];

const NAMES = { ours: 'Yours', theirs: 'Theirs', base: 'Base', result: 'Result' } as const;

/** Opens VS Code's diff editor for any two of Base / Yours / Theirs / Result (a snapshot of the current Result). */
export async function compare(sessions: SessionManager, sessionId: unknown, which?: ComparisonId): Promise<void> {
    const session = sessionFromArgs(sessions, sessionId);
    if (!session) {
        return;
    }
    const picked = which ?? (await vscode.window.showQuickPick(COMPARISONS, { placeHolder: `Compare versions of ${session.fileName}` }))?.id;
    if (!picked) {
        return;
    }
    const [left, right] = picked.split('-') as (keyof typeof NAMES)[];
    if (left === 'result' || right === 'result') {
        await session.snapshotResult();
    }
    await vscode.commands.executeCommand('vscode.diff', session.uris[left], session.uris[right],
        `${session.fileName}: ${NAMES[left]} ↔ ${NAMES[right]}`, { preview: true });
}

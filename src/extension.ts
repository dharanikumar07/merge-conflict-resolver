import * as vscode from 'vscode';
import { abortMerge, acceptFile, cancelMerge, completeMerge } from './commands/completeMerge';
import { openMergeEditor } from './commands/openMergeEditor';
import { compare, ComparisonId, registerResolveCommands } from './commands/resolveConflict';
import { REVISION_SCHEME, RevisionContentProvider } from './editor/documents';
import { SessionManager } from './editor/SessionManager';
import { getGitApi } from './git/gitExtension';
import { ConflictListProvider } from './views/ConflictListProvider';

const COMPARE_COMMANDS: Record<string, ComparisonId> = {
    'phpstorm-merge.compareYoursTheirs': 'ours-theirs',
    'phpstorm-merge.compareYoursBase': 'base-ours',
    'phpstorm-merge.compareTheirsBase': 'base-theirs',
    'phpstorm-merge.compareResultYours': 'ours-result',
    'phpstorm-merge.compareResultTheirs': 'theirs-result',
    'phpstorm-merge.compareResultBase': 'base-result',
};

/** Returned from activate() for integration tests. */
export interface MergeResolverApi {
    sessions: SessionManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<MergeResolverApi> {
    const revisions = new RevisionContentProvider();
    const sessions = new SessionManager({ revisions, extensionUri: context.extensionUri });
    const conflictList = new ConflictListProvider(await getGitApi(), sessions);
    const treeView = vscode.window.createTreeView('mergeConflictsView', { treeDataProvider: conflictList });
    conflictList.attach(treeView);

    // Commands run from UI events; surface failures instead of losing them in the console.
    const command = (id: string, handler: (...args: any[]) => unknown) =>
        vscode.commands.registerCommand(id, async (...args: any[]) => {
            try {
                await handler(...args);
            } catch (error) {
                void vscode.window.showErrorMessage(`Merge Resolver: ${(error as Error).message}`);
            }
        });

    // Buttons in the merge webview that need the host.
    sessions.onMessage((session, message) => {
        switch (message.type) {
            case 'apply': return completeMerge(sessions, session.id);
            case 'acceptFile': return acceptFile(sessions, session, message.side);
            case 'cancel': return cancelMerge(sessions, session);
            case 'compare': return compare(sessions, session.id, message.which);
        }
    });

    context.subscriptions.push(
        revisions,
        sessions,
        conflictList,
        treeView,
        vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisions),
        command('phpstorm-merge.open', arg => openMergeEditor(sessions, arg)),
        command('phpstorm-merge.refresh', () => conflictList.refresh()),
        command('phpstorm-merge.completeMerge', id => completeMerge(sessions, id)),
        command('phpstorm-merge.abortMerge', id => abortMerge(sessions, id)),
        ...Object.entries(COMPARE_COMMANDS).map(([id, which]) => command(id, () => compare(sessions, undefined, which))),
        ...registerResolveCommands(sessions, command),
    );

    return { sessions };
}

export function deactivate(): void {
    // Everything is disposed through context.subscriptions.
}

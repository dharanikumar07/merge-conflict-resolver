import * as vscode from 'vscode';
import { abortMerge, completeMerge } from './commands/completeMerge';
import { openMergeEditor } from './commands/openMergeEditor';
import { compare, ComparisonId, registerResolveCommands } from './commands/resolveConflict';
import { MergeDecorations } from './editor/decorations';
import { RESULT_SCHEME, ResultFileSystem, REVISION_SCHEME, RevisionContentProvider } from './editor/documents';
import { MergeCodeLensProvider } from './editor/MergeCodeLensProvider';
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
    const results = new ResultFileSystem();
    const decorations = new MergeDecorations();
    const sessions = new SessionManager({ revisions, results, decorations });
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

    const selector: vscode.DocumentSelector = [{ scheme: REVISION_SCHEME }, { scheme: RESULT_SCHEME }];
    context.subscriptions.push(
        decorations,
        sessions,
        conflictList,
        treeView,
        vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisions),
        vscode.workspace.registerFileSystemProvider(RESULT_SCHEME, results, { isCaseSensitive: true }),
        vscode.languages.registerCodeLensProvider(selector, new MergeCodeLensProvider(sessions)),
        command('phpstorm-merge.open', arg => openMergeEditor(sessions, arg)),
        command('phpstorm-merge.refresh', () => conflictList.refresh()),
        command('phpstorm-merge.completeMerge', id => completeMerge(sessions, id)),
        command('phpstorm-merge.abortMerge', id => abortMerge(sessions, id)),
        ...Object.entries(COMPARE_COMMANDS).map(([id, which]) => command(id, () => compare(sessions, undefined, which))),
        ...registerResolveCommands(sessions, command),
    );

    await sessions.closeStaleTabs();
    return { sessions };
}

export function deactivate(): void {
    // Everything is disposed through context.subscriptions.
}

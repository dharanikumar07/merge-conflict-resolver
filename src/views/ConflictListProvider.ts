import * as path from 'path';
import * as vscode from 'vscode';
import { GitApi, GitApiRepository } from '../git/gitExtension';
import { SessionManager } from '../editor/SessionManager';

type Node = RepositoryNode | FileNode;

class RepositoryNode extends vscode.TreeItem {
    constructor(readonly repository: GitApiRepository, readonly files: FileNode[]) {
        super(path.basename(repository.rootUri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
        const unresolved = files.filter(f => !f.resolved).length;
        this.description = unresolved > 0 ? `${unresolved} unresolved` : 'all resolved';
        this.tooltip = repository.rootUri.fsPath;
        this.iconPath = new vscode.ThemeIcon('repo');
    }
}

class FileNode extends vscode.TreeItem {
    constructor(readonly uri: vscode.Uri, readonly resolved: boolean, progress: string | undefined) {
        super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
        this.resourceUri = uri;
        this.tooltip = uri.fsPath;
        this.description = resolved ? 'resolved' : progress ?? path.dirname(vscode.workspace.asRelativePath(uri)).replace(/^\.$/, '');
        this.iconPath = resolved
            ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        this.contextValue = resolved ? 'resolvedFile' : 'conflictedFile';
        if (!resolved) {
            this.command = { command: 'phpstorm-merge.open', title: 'Open in Merge Resolver', arguments: [uri] };
        }
    }
}

/**
 * "MERGE CONFLICTS" view: conflicted files from the Git extension plus files completed in this window.
 * Also publishes the `phpstormMerge.conflictedPaths` context key used by the Explorer menu.
 */
export class ConflictListProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
    private readonly watched = new Set<GitApiRepository>();
    private view: vscode.TreeView<Node> | undefined;

    constructor(private readonly git: GitApi | undefined, private readonly sessions: SessionManager) {
        if (git) {
            git.repositories.forEach(r => this.watch(r));
            this.disposables.push(
                git.onDidOpenRepository(r => { this.watch(r); this.refresh(); }),
                git.onDidCloseRepository(() => this.refresh()),
            );
        }
        this.disposables.push(sessions.onDidChange(() => this.refresh()));
        this.refresh();
    }

    attach(view: vscode.TreeView<Node>): void {
        this.view = view;
        this.refresh();
    }

    refresh(): void {
        const conflicted = this.conflictedUris();
        void vscode.commands.executeCommand('setContext', 'phpstormMerge.conflictedPaths', conflicted.map(u => u.fsPath));
        if (this.view) {
            const resolved = [...this.sessions.completedFiles].filter(f => !conflicted.some(u => u.fsPath === f)).length;
            this.view.message = conflicted.length === 0
                ? (resolved > 0 ? 'All conflicts resolved.' : 'No merge conflicts.')
                : `Unresolved: ${conflicted.length} · Resolved: ${resolved}`;
            this.view.badge = conflicted.length > 0 ? { value: conflicted.length, tooltip: `${conflicted.length} conflicted file(s)` } : undefined;
        }
        this.changeEmitter.fire();
    }

    getTreeItem(element: Node): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Node): Node[] {
        if (element instanceof RepositoryNode) {
            return element.files;
        }
        if (element) {
            return [];
        }
        const repos = (this.git?.repositories ?? [])
            .map(r => new RepositoryNode(r, this.filesOf(r)))
            .filter(r => r.files.length > 0);
        return repos.length === 1 ? repos[0].files : repos;
    }

    private filesOf(repository: GitApiRepository): FileNode[] {
        const root = repository.rootUri.fsPath + path.sep;
        const conflicted = repository.state.mergeChanges.map(c => {
            const session = this.sessions.forFile(c.uri);
            const progress = session ? progressOf(session.state.stats) : undefined;
            return new FileNode(c.uri, false, progress);
        });
        const completed = [...this.sessions.completedFiles]
            .filter(f => f.startsWith(root) && !conflicted.some(n => n.uri.fsPath === f))
            .map(f => new FileNode(vscode.Uri.file(f), true, undefined));
        return [...conflicted, ...completed].sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
    }

    private conflictedUris(): vscode.Uri[] {
        return (this.git?.repositories ?? []).flatMap(r => r.state.mergeChanges.map(c => c.uri));
    }

    private watch(repository: GitApiRepository): void {
        if (!this.watched.has(repository)) {
            this.watched.add(repository);
            this.disposables.push(repository.state.onDidChange(() => this.refresh()));
        }
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

function progressOf(stats: { conflicts: number; unresolvedConflicts: number }): string {
    return `in progress · ${stats.conflicts - stats.unresolvedConflicts}/${stats.conflicts} resolved`;
}

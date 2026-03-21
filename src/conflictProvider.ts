import * as vscode from 'vscode';
import * as path from 'path';

export class ConflictProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | void> = new vscode.EventEmitter<TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    private gitApi: any;

    constructor() {
        this.initGitApi();
    }

    private async initGitApi() {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            const extension = await gitExtension.activate();
            this.gitApi = extension.getAPI(1);
            
            // Listen for changes in any repository
            this.gitApi.onDidOpenRepository((repo: any) => {
                repo.state.onDidChange(() => this.refresh());
            });

            this.gitApi.repositories.forEach((repo: any) => {
                repo.state.onDidChange(() => this.refresh());
            });
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!this.gitApi) {
            return [];
        }

        const repositories = this.gitApi.repositories;

        // Root level: Show repositories (Folders)
        if (!element) {
            const folderItems: WorkspaceFolderItem[] = [];
            
            for (const repo of repositories) {
                const conflicts = repo.state.mergeChanges;
                if (conflicts && conflicts.length > 0) {
                    folderItems.push(new WorkspaceFolderItem(
                        path.basename(repo.rootUri.fsPath),
                        repo.rootUri,
                        conflicts.length,
                        vscode.TreeItemCollapsibleState.Expanded,
                        conflicts
                    ));
                }
            }
            return folderItems;
        }

        // Child level: Show files inside a repository
        if (element instanceof WorkspaceFolderItem) {
            return element.conflicts.map((change: any) => {
                return new ConflictedFile(
                    path.basename(change.uri.fsPath),
                    change.uri,
                    vscode.TreeItemCollapsibleState.None
                );
            });
        }

        return [];
    }
}

type TreeItem = WorkspaceFolderItem | ConflictedFile;

class WorkspaceFolderItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly uri: vscode.Uri,
        public readonly conflictCount: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly conflicts: any[]
    ) {
        super(label, collapsibleState);
        this.tooltip = `Repository: ${this.uri.fsPath}`;
        this.description = `${conflictCount} conflicts`;
        this.iconPath = new vscode.ThemeIcon('repo');
    }
}

class ConflictedFile extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly uri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = `${this.uri.fsPath}`;
        this.description = 'Merge Conflict';
        this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        
        this.command = {
            command: 'phpstorm-merge.open',
            title: 'Open Merge Tool',
            arguments: [this.uri]
        };
    }
}

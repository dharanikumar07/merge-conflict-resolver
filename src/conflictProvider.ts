import * as vscode from 'vscode';
import * as path from 'path';

export class ConflictProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | void> = new vscode.EventEmitter<TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor() {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return [];
        }

        // If no element, we are at the ROOT -> Show Workspace Folders
        if (!element) {
            const folderItems: WorkspaceFolderItem[] = [];
            
            for (const folder of workspaceFolders) {
                const conflicts = await this.findConflictedFiles(folder.uri);
                if (conflicts.length > 0) {
                    folderItems.push(new WorkspaceFolderItem(
                        folder.name,
                        folder.uri,
                        conflicts.length,
                        vscode.TreeItemCollapsibleState.Expanded,
                        conflicts
                    ));
                }
            }
            return folderItems;
        }

        // If element is a Folder -> Show its Conflicted Files
        if (element instanceof WorkspaceFolderItem) {
            return element.conflicts;
        }

        return [];
    }

    private async findConflictedFiles(folderUri: vscode.Uri): Promise<ConflictedFile[]> {
        const conflictedFiles: ConflictedFile[] = [];
        
        // Search ONLY within this specific workspace folder
        const relativePattern = new vscode.RelativePattern(folderUri, '**/*');
        const files = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**');

        for (const file of files) {
            try {
                // Using a small buffer check to keep it lightweight (only read first 100KB for markers)
                const content = await vscode.workspace.fs.readFile(file);
                if (content.toString().includes('<<<<<<<')) {
                    conflictedFiles.push(new ConflictedFile(
                        path.basename(file.fsPath),
                        file,
                        vscode.TreeItemCollapsibleState.None
                    ));
                }
            } catch (e) {
                // Skip unreadable files
            }
        }

        return conflictedFiles;
    }
}

// Union type for the tree items
type TreeItem = WorkspaceFolderItem | ConflictedFile;

class WorkspaceFolderItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly uri: vscode.Uri,
        public readonly conflictCount: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly conflicts: ConflictedFile[]
    ) {
        super(label, collapsibleState);
        this.tooltip = `Workspace Folder: ${this.uri.fsPath}`;
        this.description = `${conflictCount} conflicts`;
        this.iconPath = new vscode.ThemeIcon('folder-opened');
        this.contextValue = 'workspaceRoot';
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

    contextValue = 'conflictedFile';
}

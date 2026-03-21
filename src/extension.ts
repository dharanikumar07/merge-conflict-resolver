import * as vscode from 'vscode';
import { ConflictProvider } from './conflictProvider';

export function activate(context: vscode.ExtensionContext) {
    // 1. Register the Sidebar Provider (Multi-Folder support handled inside)
    const conflictProvider = new ConflictProvider();
    vscode.window.registerTreeDataProvider('mergeConflictsView', conflictProvider);

    // 2. Command to Refresh the List
    context.subscriptions.push(
        vscode.commands.registerCommand('phpstorm-merge.refresh', () => conflictProvider.refresh())
    );

    // 3. Command to Open the 3-Panel UI
    context.subscriptions.push(
        vscode.commands.registerCommand('phpstorm-merge.open', (fileUri: vscode.Uri) => {
            if (!fileUri && vscode.window.activeTextEditor) {
                fileUri = vscode.window.activeTextEditor.document.uri;
            }

            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected to merge.');
                return;
            }

            openMergePanel(fileUri, context);
        })
    );

    // Auto-Refresh on File Changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(() => conflictProvider.refresh());
    watcher.onDidCreate(() => conflictProvider.refresh());
    watcher.onDidDelete(() => conflictProvider.refresh());
    context.subscriptions.push(watcher);
}

function openMergePanel(uri: vscode.Uri, context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'mergeView',
        `Merging: ${uri.fsPath.split('/').pop()}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    panel.webview.html = getWebviewContent(uri);
}

function getWebviewContent(uri: vscode.Uri) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: #1e1e1e; color: white; font-family: sans-serif; }
            .header { display: flex; justify-content: space-between; padding: 10px; background: #333; border-bottom: 1px solid #444; }
            .container { display: flex; flex: 1; width: 100%; }
            .pane { flex: 1; display: flex; flex-direction: column; border-right: 1px solid #444; }
            .pane-title { background: #252526; padding: 5px 10px; font-size: 12px; text-transform: uppercase; color: #aaa; border-bottom: 1px solid #444; }
            textarea { flex: 1; background: transparent; color: #d4d4d4; border: none; padding: 10px; font-family: 'Courier New', monospace; resize: none; outline: none; }
            .btn { background: #007acc; color: white; border: none; padding: 5px 15px; cursor: pointer; border-radius: 2px; }
            .btn:hover { background: #0062a3; }
        </style>
    </head>
    <body>
        <div class="header">
            <span>Merging: ${uri.fsPath}</span>
            <button class="btn" onclick="apply()">Apply Changes</button>
        </div>
        <div class="container">
            <div class="pane">
                <div class="pane-title">Local Changes</div>
                <textarea id="local" placeholder="Local code..."></textarea>
            </div>
            <div class="pane">
                <div class="pane-title">Result</div>
                <textarea id="result" placeholder="Result code..." style="background: #252526;"></textarea>
            </div>
            <div class="pane" style="border-right: none;">
                <div class="pane-title">Server Changes</div>
                <textarea id="server" placeholder="Server code..."></textarea>
            </div>
        </div>
        <script>
            function apply() {
                alert('Conflict resolved for: ${uri.fsPath}');
            }
        </script>
    </body>
    </html>`;
}

export function deactivate() {}

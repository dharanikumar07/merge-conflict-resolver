import * as vscode from 'vscode';
import { ConflictProvider } from './conflictProvider';

export function activate(context: vscode.ExtensionContext) {
    const conflictProvider = new ConflictProvider();
    vscode.window.registerTreeDataProvider('mergeConflictsView', conflictProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('phpstorm-merge.refresh', () => conflictProvider.refresh())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('phpstorm-merge.open', async (fileUri: vscode.Uri) => {
            if (!fileUri && vscode.window.activeTextEditor) {
                fileUri = vscode.window.activeTextEditor.document.uri;
            }

            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected.');
                return;
            }

            const panel = vscode.window.createWebviewPanel(
                'mergeView',
                `Merge: ${fileUri.fsPath.split('/').pop()}`,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            const doc = await vscode.workspace.openTextDocument(fileUri);
            const text = doc.getText();
            const chunks = parseMergeChunks(text);

            panel.webview.html = getPhpStormWebviewContent(fileUri, chunks);

            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'apply') {
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
                    edit.replace(fileUri, fullRange, message.text);
                    await vscode.workspace.applyEdit(edit);
                    await doc.save();
                    
                    // --- NEW: Git Add Logic ---
                    try {
                        const { exec } = require('child_process');
                        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
                        if (workspaceFolder) {
                            exec(`git add "${fileUri.fsPath}"`, { cwd: workspaceFolder.uri.fsPath }, (error: any) => {
                                if (error) {
                                    vscode.window.showErrorMessage('Failed to git add: ' + error.message);
                                } else {
                                    vscode.window.showInformationMessage('Changes applied and staged to Git!');
                                }
                            });
                        }
                    } catch (e) {
                        vscode.window.showInformationMessage('Merge successful (Git add skipped).');
                    }

                    panel.dispose();
                }
            });
        })
    );
}

interface MergeChunk {
    type: 'shared' | 'conflict';
    content?: string; // for shared
    local?: string;   // for conflict
    incoming?: string; // for conflict
}

function parseMergeChunks(text: string): MergeChunk[] {
    const lines = text.split(/\r?\n/);
    const chunks: MergeChunk[] = [];
    let currentShared: string[] = [];
    
    let i = 0;
    while (i < lines.length) {
        if (lines[i].startsWith('<<<<<<<')) {
            // Push any pending shared content
            if (currentShared.length > 0) {
                chunks.push({ type: 'shared', content: currentShared.join('\n') });
                currentShared = [];
            }
            
            let localLines = [];
            let incomingLines = [];
            i++; // skip <<<<<<<
            
            while (i < lines.length && !lines[i].startsWith('=======')) {
                localLines.push(lines[i]);
                i++;
            }
            i++; // skip =======
            
            while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
                incomingLines.push(lines[i]);
                i++;
            }
            i++; // skip >>>>>>>
            
            chunks.push({
                type: 'conflict',
                local: localLines.join('\n'),
                incoming: incomingLines.join('\n')
            });
        } else {
            currentShared.push(lines[i]);
            i++;
        }
    }
    
    if (currentShared.length > 0) {
        chunks.push({ type: 'shared', content: currentShared.join('\n') });
    }
    
    return chunks;
}

function getPhpStormWebviewContent(uri: vscode.Uri, chunks: MergeChunk[]) {
    const fileName = uri.fsPath.split('/').pop();
    
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            :root {
                --bg: #1e1e1e;
                --header-bg: #2d2d2d;
                --panel-header: #252526;
                --border: #444;
                --text: #d4d4d4;
                --conflict-bg: rgba(75, 75, 0, 0.2);
                --local-highlight: rgba(63, 131, 248, 0.15);
                --incoming-highlight: rgba(34, 197, 94, 0.15);
                --accent: #007acc;
            }
            body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow: hidden; }
            
            /* Header */
            .toolbar { background: var(--header-bg); padding: 8px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); box-shadow: 0 2px 5px rgba(0,0,0,0.2); z-index: 100; }
            .title { font-size: 13px; color: #aaa; }
            .title b { color: #fff; }
            
            /* Main Layout */
            .editor-container { display: flex; flex: 1; overflow: hidden; position: relative; }
            .column { flex: 1; display: flex; flex-direction: column; position: relative; min-width: 0; }
            .column-header { background: var(--panel-header); padding: 6px 12px; font-size: 11px; font-weight: bold; text-transform: uppercase; color: #888; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; }
            
            /* Content Area */
            .content { flex: 1; overflow-y: auto; overflow-x: auto; font-family: 'JetBrains Mono', 'Consolas', monospace; font-size: 13px; line-height: 1.6; white-space: pre; position: relative; }
            .line-row { display: flex; min-width: fit-content; }
            .line-number { width: 40px; text-align: right; padding-right: 10px; color: #6e7681; user-select: none; background: #1e1e1e; border-right: 1px solid #333; margin-right: 10px; flex-shrink: 0; }
            
            /* Conflict Styling */
            .chunk-shared { }
            .chunk-conflict { background: var(--conflict-bg); }
            .local-side { background: var(--local-highlight); border-left: 3px solid #3f83f8; }
            .incoming-side { background: var(--incoming-highlight); border-right: 3px solid #22c55e; }
            
            /* Action Gutter / Resizer */
            .gutter { width: 34px; background: #252526; display: flex; flex-direction: column; align-items: center; border-left: 1px solid var(--border); border-right: 1px solid var(--border); flex-shrink: 0; cursor: col-resize; transition: background 0.2s; }
            .gutter:hover { background: #333; border-left-color: var(--accent); border-right-color: var(--accent); }
            .action-btn { cursor: pointer; color: #aaa; font-size: 14px; padding: 2px; margin-top: 4px; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 3px; cursor: pointer; pointer-events: auto; }
            
            /* Add this to prevent text selection while dragging */
            .resizing { user-select: none !important; cursor: col-resize !important; }
            .resizing * { pointer-events: none !important; }
            .action-btn { pointer-events: auto !important; }

            /* Footer */
            .footer { padding: 12px 20px; background: var(--header-bg); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
            .btn-main { background: var(--accent); color: white; border: none; padding: 6px 20px; border-radius: 3px; cursor: pointer; font-weight: 500; }
            .btn-main:hover { background: #0062a3; }
            .btn-cancel { background: transparent; color: #ccc; border: 1px solid #444; padding: 6px 15px; border-radius: 3px; cursor: pointer; }

            #result-editor { outline: none; background: #1a1a1a; }
        </style>
    </head>
    <body>
        <div class="toolbar">
            <div class="title">Merge Revisions for <b>${fileName}</b></div>
        </div>

        <div class="editor-container">
            <!-- Left: Local -->
            <div class="column">
                <div class="column-header">Local Changes</div>
                <div class="content" id="local-view"></div>
            </div>

            <div class="gutter" id="left-gutter"></div>

            <!-- Center: Result -->
            <div class="column" style="flex: 1.2;">
                <div class="column-header">Result</div>
                <div class="content" id="result-editor" contenteditable="true"></div>
            </div>

            <div class="gutter" id="right-gutter"></div>

            <!-- Right: Incoming -->
            <div class="column">
                <div class="column-header">Incoming Changes</div>
                <div class="content" id="incoming-view"></div>
            </div>
        </div>

        <div class="footer">
            <div style="flex: 1; display: flex; gap: 10px;">
                <button class="btn-cancel" onclick="acceptAll('local')" style="color: #3f83f8; border-color: #3f83f8;">Accept Left (All Local)</button>
                <button class="btn-cancel" onclick="acceptAll('incoming')" style="color: #22c55e; border-color: #22c55e;">Accept Right (All Server)</button>
            </div>
            <button class="btn-cancel" onclick="window.close()">Cancel</button>
            <button class="btn-main" onclick="apply()">Apply</button>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            const chunks = ${JSON.stringify(chunks)};
            
            // ... (rest of the existing script variables)

            function acceptAll(side) {
                let fullContent = '';
                chunks.forEach(chunk => {
                    if (chunk.type === 'shared') {
                        fullContent += chunk.content + '\\n';
                    } else {
                        fullContent += (side === 'local' ? chunk.local : chunk.incoming) + '\\n';
                    }
                });
                
                // Remove the last newline and apply
                vscode.postMessage({
                    command: 'apply',
                    text: fullContent.trimEnd()
                });
            }
            
            const container = document.querySelector('.editor-container');
            const columns = document.querySelectorAll('.column');
            const localView = document.getElementById('local-view');
            const resultEditor = document.getElementById('result-editor');
            const incomingView = document.getElementById('incoming-view');
            const leftGutter = document.getElementById('left-gutter');
            const rightGutter = document.getElementById('right-gutter');

            // --- Resizing Logic ---
            let isResizing = false;
            let currentResizer = null;

            function initResizer(resizer, leftSide, rightSide) {
                resizer.addEventListener('mousedown', (e) => {
                    // Only start resizing if we didn't click an action button
                    if (e.target.classList.contains('action-btn')) return;
                    
                    isResizing = true;
                    currentResizer = { resizer, leftSide, rightSide };
                    document.body.classList.add('resizing');
                });
            }

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;

                const containerRect = container.getBoundingClientRect();
                const mouseX = e.clientX - containerRect.left;
                const totalWidth = containerRect.width;

                if (currentResizer.resizer === leftGutter) {
                    const leftWidth = (mouseX / totalWidth) * 100;
                    if (leftWidth > 10 && leftWidth < 45) {
                        columns[0].style.flex = "0 0 " + leftWidth + "%";
                    }
                } else if (currentResizer.resizer === rightGutter) {
                    const rightWidth = ((totalWidth - mouseX) / totalWidth) * 100;
                    if (rightWidth > 10 && rightWidth < 45) {
                        columns[2].style.flex = "0 0 " + rightWidth + "%";
                    }
                }
            });

            document.addEventListener('mouseup', () => {
                isResizing = false;
                document.body.classList.remove('resizing');
            });

            initResizer(leftGutter, columns[0], columns[1]);
            initResizer(rightGutter, columns[1], columns[2]);

            // --- Rendering Logic ---
            let chunkStates = chunks.map(c => ({
                localAccepted: false,
                incomingAccepted: false,
                ignored: false
            }));

            function render() {
                localView.innerHTML = '';
                resultEditor.innerHTML = '';
                incomingView.innerHTML = '';
                leftGutter.innerHTML = '';
                rightGutter.innerHTML = '';

                chunks.forEach((chunk, index) => {
                    if (chunk.type === 'shared') {
                        addLines(localView, chunk.content, 'chunk-shared');
                        addLines(resultEditor, chunk.content, 'chunk-shared');
                        addLines(incomingView, chunk.content, 'chunk-shared');
                        addGutterPadding(leftGutter, chunk.content);
                        addGutterPadding(rightGutter, chunk.content);
                    } else {
                        // Conflict Blocks
                        addLines(localView, chunk.local, 'chunk-conflict local-side');
                        addLines(incomingView, chunk.incoming, 'chunk-conflict incoming-side');
                        
                        // Result calculation
                        let resContent = '';
                        if (chunkStates[index].localAccepted) resContent += chunk.local + '\\n';
                        if (chunkStates[index].incomingAccepted) resContent += chunk.incoming + '\\n';
                        if (!chunkStates[index].localAccepted && !chunkStates[index].incomingAccepted && !chunkStates[index].ignored) {
                            resContent = '/* CONFLICT */';
                        }
                        addLines(resultEditor, resContent, 'chunk-conflict result-side');

                        // Gutters
                        addActions(leftGutter, index, 'local');
                        addActions(rightGutter, index, 'incoming');
                    }
                });
            }

            function addLines(parent, text, className) {
                const div = document.createElement('div');
                div.className = className;
                div.textContent = text || ' ';
                parent.appendChild(div);
            }

            function addGutterPadding(parent, text) {
                const count = (text.match(/\\n/g) || []).length + 1;
                const div = document.createElement('div');
                div.style.height = (count * 1.6) + 'em';
                parent.appendChild(div);
            }

            function addActions(parent, index, side) {
                const container = document.createElement('div');
                container.style.height = '100px'; // Approx match to conflict block height
                
                const accept = document.createElement('div');
                accept.className = 'action-btn btn-accept';
                accept.innerHTML = side === 'local' ? '≫' : '≪';
                accept.onclick = () => {
                    if (side === 'local') chunkStates[index].localAccepted = true;
                    else chunkStates[index].incomingAccepted = true;
                    render();
                };

                const ignore = document.createElement('div');
                ignore.className = 'action-btn btn-ignore';
                ignore.innerHTML = '✕';
                ignore.onclick = () => {
                    chunkStates[index].ignored = true;
                    render();
                };

                container.appendChild(accept);
                container.appendChild(ignore);
                parent.appendChild(container);
            }

            function apply() {
                vscode.postMessage({
                    command: 'apply',
                    text: resultEditor.innerText
                });
            }

            render();
        </script>
    </body>
    </html>`;
}

export function deactivate() {}

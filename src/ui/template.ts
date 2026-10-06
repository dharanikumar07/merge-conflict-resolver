import { styles } from './styles';

export function getMergeTemplate(fileName: string, localDiff: any[], incomingDiff: any[]) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>${styles}</style>
    </head>
    <body class="jetbrains-dark">
        <!-- Toolbar -->
        <div class="toolbar">
            <div>Merge Revisions for <b>${fileName}</b></div>
            <div style="font-size: 11px; opacity: 0.7;">Myers Diff Algorithm • Shift-Aware</div>
        </div>

        <!-- Main Editor Container -->
        <div class="editor-container">
            <!-- Left: Local -->
            <div class="column">
                <div class="column-header">Local Changes</div>
                <div class="content" id="local-view"></div>
            </div>

            <!-- Left Gutter -->
            <div class="gutter" id="left-gutter"></div>

            <!-- Center: Result -->
            <div class="column result-column">
                <div class="column-header">Result</div>
                <div class="content" id="result-editor" contenteditable="true"></div>
            </div>

            <!-- Right Gutter -->
            <div class="gutter" id="right-gutter"></div>

            <!-- Right: Incoming -->
            <div class="column">
                <div class="column-header">Incoming Changes</div>
                <div class="content" id="incoming-view"></div>
            </div>
        </div>

        <!-- Footer -->
        <div class="footer">
            <button class="btn btn-cancel" onclick="vscode.postMessage({command:'cancel'})">Cancel</button>
            <button class="btn btn-apply" onclick="apply()">Apply</button>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            const localDiff = ${JSON.stringify(localDiff)};
            const incomingDiff = ${JSON.stringify(incomingDiff)};
            
            ${getScript()}
        </script>
    </body>
    </html>`;
}

function getScript() {
    return `
        const localV = document.getElementById('local-view');
        const resV = document.getElementById('result-editor');
        const incomingV = document.getElementById('incoming-view');
        const leftG = document.getElementById('left-gutter');
        const rightG = document.getElementById('right-gutter');

        let acceptedLocal = new Set();
        let acceptedIncoming = new Set();
        let ignoredLocal = new Set();
        let ignoredIncoming = new Set();

        /**
         * 🏁 MASTER RENDERER: The only way to get perfect alignment
         */
        function render() {
            [localV, resV, incomingV, leftG, rightG].forEach(v => v.innerHTML = '');

            // Convert Diff Parts to Alignable Blocks
            const localBlocks = diffToBlocks(localDiff);
            const incomingBlocks = diffToBlocks(incomingDiff);

            // We align based on the LOCAL side as the master timeline for this view
            let currentResLine = 1;

            localBlocks.forEach((block, idx) => {
                const heightEm = (block.lines.length * 1.8);
                
                // 1. Render Local Panel
                localV.appendChild(createBlockEl(block.lines, block.type, block.startLine));

                // 2. Render Left Gutter (PERFECTLY CENTERED)
                const gutterRow = document.createElement('div');
                gutterRow.style.height = heightEm + "em";
                gutterRow.style.position = 'relative';
                
                if (block.type !== 'unchanged') {
                    const actionGroup = document.createElement('div');
                    actionGroup.className = 'action-container';
                    actionGroup.style.height = "100%"; // Flexbox will center children
                    
                    const acc = document.createElement('div');
                    acc.className = 'btn-icon btn-acc';
                    acc.innerHTML = '≫';
                    acc.title = 'Accept Local';
                    acc.onclick = () => { acceptedLocal.add(idx); ignoredLocal.delete(idx); render(); };

                    const x = document.createElement('div');
                    x.className = 'btn-icon btn-x';
                    x.innerHTML = '✕';
                    x.title = 'Ignore';
                    x.onclick = () => { ignoredLocal.add(idx); acceptedLocal.delete(idx); render(); };

                    actionGroup.appendChild(acc);
                    actionGroup.appendChild(x);
                    gutterRow.appendChild(actionGroup);
                }
                leftG.appendChild(gutterRow);

                // 3. Render Result (Sync height with Local)
                let resLines = [];
                if (block.type === 'unchanged' || acceptedLocal.has(idx)) {
                    resLines = [...block.lines];
                } else if (block.type === 'removed' && !ignoredLocal.has(idx)) {
                    resLines = [...block.lines];
                } else {
                    resLines = new Array(block.lines.length).fill(""); // Spacer
                }
                resV.appendChild(createBlockEl(resLines, '', currentResLine));
                currentResLine += resLines.length;
            });

            // 4. Render Incoming Panel (Synced to its own diff)
            incomingBlocks.forEach((block, idx) => {
                const heightEm = (block.lines.length * 1.8);
                incomingV.appendChild(createBlockEl(block.lines, block.type, block.startLine));

                const gutterRow = document.createElement('div');
                gutterRow.style.height = heightEm + "em";
                gutterRow.style.position = 'relative';

                if (block.type !== 'unchanged') {
                    const actionGroup = document.createElement('div');
                    actionGroup.className = 'action-container';
                    actionGroup.style.height = "100%";

                    const acc = document.createElement('div');
                    acc.className = 'btn-icon btn-acc';
                    acc.innerHTML = '≪';
                    acc.title = 'Accept Incoming';
                    acc.onclick = () => { acceptedIncoming.add(idx); ignoredIncoming.delete(idx); render(); };

                    const x = document.createElement('div');
                    x.className = 'btn-icon btn-x';
                    x.innerHTML = '✕';
                    x.title = 'Ignore';
                    x.onclick = () => { ignoredIncoming.add(idx); acceptedIncoming.delete(idx); render(); };

                    actionGroup.appendChild(acc);
                    actionGroup.appendChild(x);
                    gutterRow.appendChild(actionGroup);
                }
                rightG.appendChild(gutterRow);
            });
        }

        function diffToBlocks(diff) {
            let lineNum = 1;
            return diff.map(part => {
                const lines = part.value.split(/\\r?\\n/);
                if (lines[lines.length-1] === "") lines.pop();
                const b = { type: part.added ? 'added' : (part.removed ? 'removed' : 'unchanged'), lines, startLine: lineNum };
                if (!part.removed) lineNum += lines.length;
                return b;
            });
        }

        function createBlockEl(lines, type, startLine) {
            const div = document.createElement('div');
            div.className = 'diff-block ' + (type === 'added' ? 'block-added' : (type === 'removed' ? 'block-removed' : ''));
            lines.forEach((line, i) => {
                const row = document.createElement('div');
                row.className = 'line-row';
                row.innerHTML = \`<div class="line-num">\${startLine + i}</div><div class="line-text">\${line.replace(/</g, '&lt;')}</div>\`;
                div.appendChild(row);
            });
            return div;
        }

        function apply() {
            const text = Array.from(resV.querySelectorAll('.line-text')).map(el => el.innerText).join('\\n');
            vscode.postMessage({ command: 'apply', text });
        }

        render();

        // 🔄 Pro Sync-Scroll Logic
        const panels = [localV, resV, incomingV];
        panels.forEach(p => {
            p.onscroll = () => {
                panels.forEach(other => { if (other !== p) other.scrollTop = p.scrollTop; });
                // Also scroll gutters!
                leftG.scrollTop = p.scrollTop;
                rightG.scrollTop = p.scrollTop;
            };
        });
    `;
}

import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService, MergeStatus } from '../git/GitService';
import { MergeStats } from '../merge/MergeModel';
import type { ActionReply, HostMessage, MergeAction, ViewState, WebviewMessage } from '../shared/protocol';
import { Revision, RevisionContentProvider, revisionUri } from './documents';

export const WEBVIEW_TYPE = 'phpstormMerge.mergeEditor';

export interface SessionServices {
    revisions: RevisionContentProvider;
    extensionUri: vscode.Uri;
}

export interface SessionSource {
    fileUri: vscode.Uri;
    git: GitService | undefined;
    relativePath: string;
    /** The three versions, normalized to `eol`. */
    texts: { base: string; ours: string; theirs: string };
    eol: '\n' | '\r\n';
    initialStats: MergeStats;
    labels: MergeStatus;
    languageId: string;
    /** Content of the working file when the session started; used to detect concurrent changes before writing. */
    workingSnapshot: string | undefined;
}

export interface SessionEvents {
    /** The webview reported a new state (stats, cursor, dirty flag). */
    onState(session: MergeSession): void;
    /** A button in the webview needs the host (Apply, Cancel, Accept Left/Right, Compare). */
    onMessage(session: MergeSession, message: WebviewMessage): void;
    onViewState(session: MergeSession): void;
    onDispose(session: MergeSession): void;
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One merge of one file, shown in a webview panel: Yours (read-only) | Result (editable) | Theirs (read-only).
 * The merge state lives in the webview; this side mirrors its last reported state and talks to Git.
 */
export class MergeSession implements vscode.Disposable {
    readonly fileName: string;
    readonly uris: Record<Revision, vscode.Uri>;
    state: ViewState;
    closing = false;
    /** Set once the webview has received its content. */
    ready = false;

    private panel: vscode.WebviewPanel | undefined;
    private disposed = false;
    private readonly whenReady: Promise<void>;
    private markReady!: () => void;
    private nextRequestId = 1;
    private readonly pending = new Map<number, { resolve(reply: ActionReply): void; reject(error: Error): void }>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(readonly id: string, readonly source: SessionSource, private readonly services: SessionServices, private readonly events: SessionEvents) {
        this.fileName = path.basename(source.fileUri.fsPath);
        this.uris = {
            ours: revisionUri(id, 'ours', `${this.fileName} (Yours)`),
            theirs: revisionUri(id, 'theirs', `${this.fileName} (Theirs)`),
            base: revisionUri(id, 'base', `${this.fileName} (Base)`),
            result: revisionUri(id, 'result', `${this.fileName} (Result)`),
        };
        for (const rev of ['ours', 'theirs', 'base'] as const) {
            services.revisions.set(this.uris[rev], source.texts[rev]);
        }
        services.revisions.set(this.uris.result, source.texts.base);
        this.state = { stats: source.initialStats, dirty: false };
        this.whenReady = new Promise(resolve => { this.markReady = resolve; });
    }

    get active(): boolean {
        return !!this.panel?.active;
    }

    /** Opens the merge panel, or brings it to the front. */
    show(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        const root = vscode.Uri.joinPath(this.services.extensionUri, 'dist', 'webview');
        const panel = vscode.window.createWebviewPanel(WEBVIEW_TYPE, `Merge: ${this.fileName}`, vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true, // the merge state lives in the webview
            localResourceRoots: [root],
        });
        this.panel = panel;
        const media = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        panel.iconPath = { light: vscode.Uri.joinPath(media, 'merge-light.svg'), dark: vscode.Uri.joinPath(media, 'merge-dark.svg') };
        panel.webview.html = this.html(panel.webview, root);
        this.disposables.push(
            panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.receive(message)),
            panel.onDidChangeViewState(() => this.events.onViewState(this)),
            panel.onDidDispose(() => {
                this.panel = undefined;
                this.dispose(); // the user closed the tab
            }),
        );
    }

    /** Runs an action in the webview and resolves with the resulting state and Result text. */
    async request(action: MergeAction, options: { chunkId?: number; line?: number } = {}): Promise<ActionReply> {
        await this.whenReady;
        if (!this.panel) {
            throw new Error(`The merge editor for ${this.fileName} is closed.`);
        }
        const requestId = this.nextRequestId++;
        const reply = new Promise<ActionReply>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            setTimeout(() => {
                if (this.pending.delete(requestId)) {
                    reject(new Error(`The merge editor did not respond (${action}).`));
                }
            }, REQUEST_TIMEOUT_MS);
        });
        this.post({ type: 'action', action, requestId, ...options });
        const result = await reply;
        this.state = result.state;
        this.events.onState(this);
        return result;
    }

    /** The current Result text. */
    async resultText(): Promise<string> {
        return (await this.request('sync')).result;
    }

    /** Copies the current Result into its read-only document, for the Compare editors. */
    async snapshotResult(): Promise<void> {
        this.services.revisions.set(this.uris.result, await this.resultText());
    }

    private post(message: HostMessage): void {
        void this.panel?.webview.postMessage(message);
    }

    private receive(message: WebviewMessage): void {
        switch (message.type) {
            case 'ready':
                this.post({
                    type: 'init',
                    data: {
                        fileName: this.fileName,
                        relativePath: this.source.relativePath,
                        languageId: this.source.languageId,
                        eol: this.source.eol,
                        ...this.source.texts,
                        oursLabel: this.source.labels.oursLabel,
                        theirsLabel: this.source.labels.theirsLabel,
                        autoApplyNonConflicting: vscode.workspace.getConfiguration('phpstormMerge').get<boolean>('autoApplyNonConflictingChanges') ?? false,
                    },
                });
                this.ready = true;
                this.markReady();
                return;
            case 'state':
                this.state = message.state;
                this.events.onState(this);
                return;
            case 'reply':
                this.pending.get(message.requestId)?.resolve(message.reply);
                this.pending.delete(message.requestId);
                return;
            case 'info':
                void vscode.window.showInformationMessage(`${this.fileName}: ${message.message}`);
                return;
            default:
                this.events.onMessage(this, message);
        }
    }

    private html(webview: vscode.Webview, root: vscode.Uri): string {
        const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString();
        const nonce = randomBytes(16).toString('base64');
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`, // Monaco injects its own <style> elements
            `font-src ${webview.cspSource} data:`,
            `img-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`,
            `worker-src blob:`,
            `connect-src ${webview.cspSource}`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('main.css')}">
<title>Merge ${escapeHtml(this.fileName)}</title>
</head>
<body data-worker-url="${asset('editor.worker.js')}">
<div id="app"></div>
<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.closing = true;
        for (const { reject } of this.pending.values()) {
            reject(new Error(`The merge editor for ${this.fileName} was closed.`));
        }
        this.pending.clear();
        for (const rev of ['ours', 'theirs', 'base', 'result'] as const) {
            this.services.revisions.delete(this.uris[rev]);
        }
        this.disposables.forEach(d => d.dispose());
        const panel = this.panel;
        this.panel = undefined;
        panel?.dispose();
        this.events.onDispose(this);
    }
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

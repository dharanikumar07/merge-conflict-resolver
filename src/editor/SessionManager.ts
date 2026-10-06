import * as vscode from 'vscode';
import type { WebviewMessage } from '../shared/protocol';
import { sessionIdOf } from './documents';
import { MergeSession, SessionServices, SessionSource } from './MergeSession';

const REFRESH_DELAY_MS = 60;

export type MessageHandler = (session: MergeSession, message: WebviewMessage) => unknown;

/** Owns all open merge sessions and keeps the status bar, context keys and conflict list in sync with them. */
export class SessionManager implements vscode.Disposable {
    private readonly sessions = new Map<string, MergeSession>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    /** Fires (debounced) whenever any session's state may have changed. */
    readonly onDidChange = this.changeEmitter.event;
    /** Files completed in this window, shown as resolved in the conflict list. */
    readonly completedFiles = new Set<string>();

    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    private messageHandler: MessageHandler | undefined;
    private nextId = 1;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(private readonly services: SessionServices) {}

    /** Handles the webview buttons that need the host (Apply, Cancel, Accept Left/Right, Compare). */
    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    create(source: SessionSource): MergeSession {
        const session = new MergeSession(String(this.nextId++), source, this.services, {
            onState: () => this.scheduleRefresh(),
            onViewState: () => this.updateStatus(),
            onMessage: (s, message) => {
                Promise.resolve(this.messageHandler?.(s, message)).catch((error: Error) =>
                    vscode.window.showErrorMessage(`Merge Resolver: ${error.message}`));
            },
            onDispose: s => this.forget(s),
        });
        this.sessions.set(session.id, session);
        return session;
    }

    get(id: string): MergeSession | undefined {
        return this.sessions.get(id);
    }

    all(): MergeSession[] {
        return [...this.sessions.values()];
    }

    forFile(fileUri: vscode.Uri): MergeSession | undefined {
        const key = fileUri.toString();
        return this.all().find(s => s.source.fileUri.toString() === key);
    }

    /** The session a Compare editor (phpmerge-rev:) belongs to. */
    forUri(uri: vscode.Uri): MergeSession | undefined {
        const id = sessionIdOf(uri);
        return id ? this.sessions.get(id) : undefined;
    }

    /** The session whose merge panel is focused, else the one whose Compare editor is active. */
    active(): MergeSession | undefined {
        const editorUri = vscode.window.activeTextEditor?.document.uri;
        return this.all().find(s => s.active) ?? (editorUri ? this.forUri(editorUri) : undefined);
    }

    /** Closes the merge panel and forgets the session. The real file is not touched. */
    async close(session: MergeSession): Promise<void> {
        if (session.closing) {
            return;
        }
        const compareTabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t =>
            t.input instanceof vscode.TabInputTextDiff && (this.forUri(t.input.original) === session || this.forUri(t.input.modified) === session));
        session.dispose();
        if (compareTabs.length > 0) {
            await vscode.window.tabGroups.close(compareTabs, true);
        }
    }

    scheduleRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.updateStatus();
            this.changeEmitter.fire();
        }, REFRESH_DELAY_MS);
    }

    updateStatus(): void {
        const session = this.all().find(s => s.active);
        void vscode.commands.executeCommand('setContext', 'phpstormMerge.inSession', !!session);
        if (!session) {
            this.statusBar.hide();
            return;
        }
        const { stats, currentConflict } = session.state;
        void vscode.commands.executeCommand('setContext', 'phpstormMerge.allResolved', stats.unresolvedConflicts === 0);
        const pending = stats.pendingChanges > 0 ? ` · ${stats.pendingChanges} change${stats.pendingChanges === 1 ? '' : 's'} pending` : '';
        if (stats.unresolvedConflicts === 0) {
            this.statusBar.text = '$(check) Complete Merge';
            this.statusBar.tooltip = `All ${stats.conflicts} conflict(s) in ${session.fileName} resolved${pending}. Click to write the result and mark the file resolved.`;
            this.statusBar.command = 'phpstorm-merge.completeMerge';
        } else {
            const position = currentConflict ? `Conflict ${currentConflict} of ${stats.conflicts}` : `${stats.conflicts} conflict${stats.conflicts === 1 ? '' : 's'}`;
            this.statusBar.text = `$(git-merge) ${position} · ${stats.unresolvedConflicts} unresolved${pending}`;
            this.statusBar.tooltip = 'Go to the next unresolved conflict (F7)';
            this.statusBar.command = 'phpstorm-merge.nextConflict';
        }
        this.statusBar.show();
    }

    private forget(session: MergeSession): void {
        this.sessions.delete(session.id);
        this.updateStatus();
        this.changeEmitter.fire();
    }

    dispose(): void {
        this.all().forEach(s => s.dispose());
        this.sessions.clear();
        this.statusBar.dispose();
        this.changeEmitter.dispose();
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
    }
}

import * as vscode from 'vscode';
import { RESULT_SCHEME, REVISION_SCHEME, sessionIdOf } from './documents';
import { MergeSession, SessionServices, SessionSource } from './MergeSession';

const REFRESH_DELAY_MS = 60;

/** Owns all open merge sessions and keeps decorations, CodeLenses, status bar and context keys in sync with them. */
export class SessionManager implements vscode.Disposable {
    private readonly sessions = new Map<string, MergeSession>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    /** Fires (debounced) whenever any session's state may have changed. */
    readonly onDidChange = this.changeEmitter.event;
    /** Files completed in this window, shown as resolved in the conflict list. */
    readonly completedFiles = new Set<string>();

    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    private readonly disposables: vscode.Disposable[] = [];
    private readonly lastUnresolved = new Map<string, number>();
    private nextId = 1;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(private readonly services: SessionServices) {
        this.disposables.push(
            this.statusBar,
            this.changeEmitter,
            vscode.workspace.onDidChangeTextDocument(e => {
                const session = this.forUri(e.document.uri);
                if (session && !session.closing && session.roleOf(e.document.uri) === 'result' && e.contentChanges.length > 0) {
                    session.handleResultChange(e);
                    this.scheduleRefresh();
                }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (this.forUri(e.textEditor.document.uri)) {
                    this.updateStatus();
                }
            }),
            vscode.window.onDidChangeTextEditorVisibleRanges(e => this.forUri(e.textEditor.document.uri)?.syncScroll(e.textEditor)),
            vscode.window.tabGroups.onDidChangeTabs(() => this.closeSessionsWithoutResultTab()),
        );
    }

    create(source: SessionSource): MergeSession {
        const session = new MergeSession(String(this.nextId++), source, this.services);
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

    forUri(uri: vscode.Uri): MergeSession | undefined {
        const id = sessionIdOf(uri);
        return id ? this.sessions.get(id) : undefined;
    }

    active(): MergeSession | undefined {
        const editor = vscode.window.activeTextEditor;
        return editor ? this.forUri(editor.document.uri) : undefined;
    }

    /** Closes the session's editors without save prompts and forgets it. The real file is not touched. */
    async close(session: MergeSession): Promise<void> {
        if (session.closing) {
            return;
        }
        session.closing = true;
        // The Result lives in memory; "saving" it there just clears the dirty flag so closing doesn't prompt.
        const doc = session.resultDocument;
        if (doc?.isDirty) {
            await doc.save();
        }
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
            .filter(t => t.input instanceof vscode.TabInputText && session.owns(t.input.uri)
                || t.input instanceof vscode.TabInputTextDiff && (session.owns(t.input.original) || session.owns(t.input.modified)));
        await vscode.window.tabGroups.close(tabs, true);
        this.forget(session);
    }

    /** Closes tabs restored from a previous window session; their in-memory content no longer exists. */
    async closeStaleTabs(): Promise<void> {
        const stale = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => {
            const uri = t.input instanceof vscode.TabInputText ? t.input.uri : undefined;
            return uri && (uri.scheme === RESULT_SCHEME || uri.scheme === REVISION_SCHEME) && !this.forUri(uri);
        });
        if (stale.length > 0) {
            await vscode.window.tabGroups.close(stale, true);
        }
    }

    scheduleRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.sessions.forEach(s => s.render());
            this.updateStatus();
            this.notifyWhenResolved();
            this.changeEmitter.fire();
        }, REFRESH_DELAY_MS);
    }

    updateStatus(): void {
        const editor = vscode.window.activeTextEditor;
        const session = editor && this.forUri(editor.document.uri);
        void vscode.commands.executeCommand('setContext', 'phpstormMerge.inSession', !!session);
        if (!editor || !session) {
            this.statusBar.hide();
            return;
        }
        const stats = session.model.stats();
        void vscode.commands.executeCommand('setContext', 'phpstormMerge.allResolved', stats.unresolvedConflicts === 0);
        const conflicts = session.model.conflicts;
        const current = session.chunkAtCursor(editor);
        const pending = stats.pendingChanges > 0 ? ` · ${stats.pendingChanges} change${stats.pendingChanges === 1 ? '' : 's'} pending` : '';

        if (stats.unresolvedConflicts === 0) {
            this.statusBar.text = `$(check) Complete Merge`;
            this.statusBar.tooltip = `All ${conflicts.length} conflict(s) in ${session.fileName} resolved${pending}. Click to write the result and mark the file resolved.`;
            this.statusBar.command = 'phpstorm-merge.completeMerge';
        } else {
            const position = current?.isConflict ? `Conflict ${conflicts.indexOf(current) + 1} of ${conflicts.length}` : `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`;
            this.statusBar.text = `$(git-merge) ${position} · ${stats.unresolvedConflicts} unresolved${pending}`;
            this.statusBar.tooltip = 'Go to the next unresolved conflict (F7)';
            this.statusBar.command = 'phpstorm-merge.nextConflict';
        }
        this.statusBar.show();
    }

    private notifyWhenResolved(): void {
        for (const session of this.sessions.values()) {
            const unresolved = session.model.stats().unresolvedConflicts;
            const previous = this.lastUnresolved.get(session.id);
            this.lastUnresolved.set(session.id, unresolved);
            if (previous !== undefined && previous > 0 && unresolved === 0) {
                void vscode.window.showInformationMessage(`All conflicts in ${session.fileName} are resolved.`, 'Complete Merge')
                    .then(choice => choice && vscode.commands.executeCommand('phpstorm-merge.completeMerge', session.id));
            }
        }
    }

    private closeSessionsWithoutResultTab(): void {
        const open = new Set(vscode.window.tabGroups.all.flatMap(g => g.tabs)
            .map(t => t.input instanceof vscode.TabInputText ? t.input.uri.toString() : undefined));
        for (const session of this.sessions.values()) {
            if (session.ready && !session.closing && !open.has(session.uris.result.toString())) {
                void this.close(session);
            }
        }
    }

    private forget(session: MergeSession): void {
        session.dispose();
        this.sessions.delete(session.id);
        this.lastUnresolved.delete(session.id);
        this.updateStatus();
        this.changeEmitter.fire();
    }

    dispose(): void {
        this.sessions.forEach(s => s.dispose());
        this.sessions.clear();
        this.disposables.forEach(d => d.dispose());
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
    }
}

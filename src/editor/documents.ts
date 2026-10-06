import * as vscode from 'vscode';

/** Read-only versions (Base / Yours / Theirs, and Result snapshots) used by the Compare commands. */
export const REVISION_SCHEME = 'mergeflow-rev';

export type Revision = 'ours' | 'theirs' | 'base' | 'result';

export function revisionUri(sessionId: string, revision: Revision, title: string): vscode.Uri {
    return vscode.Uri.from({ scheme: REVISION_SCHEME, path: `/${sessionId}/${revision}/${title}` });
}

/** Extracts the session id from one of our URIs. */
export function sessionIdOf(uri: vscode.Uri): string | undefined {
    return uri.scheme === REVISION_SCHEME ? uri.path.split('/')[1] : undefined;
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly contents = new Map<string, string>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changeEmitter.event;

    set(uri: vscode.Uri, text: string): void {
        const key = uri.toString();
        const changed = this.contents.has(key) && this.contents.get(key) !== text;
        this.contents.set(key, text);
        if (changed) {
            this.changeEmitter.fire(uri); // e.g. a newer Result snapshot for an open Compare editor
        }
    }

    delete(uri: vscode.Uri): void {
        this.contents.delete(uri.toString());
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}

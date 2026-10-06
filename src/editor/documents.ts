import * as vscode from 'vscode';

/** Read-only versions (Yours / Theirs / Base). Content-provider documents cannot be edited by the user. */
export const REVISION_SCHEME = 'phpmerge-rev';
/** The editable Result. Lives in memory until "Complete Merge" writes it to the real file. */
export const RESULT_SCHEME = 'phpmerge-result';

export type Revision = 'ours' | 'theirs' | 'base';

export function revisionUri(sessionId: string, revision: Revision, title: string): vscode.Uri {
    return vscode.Uri.from({ scheme: REVISION_SCHEME, path: `/${sessionId}/${revision}/${title}` });
}

export function resultUri(sessionId: string, title: string): vscode.Uri {
    return vscode.Uri.from({ scheme: RESULT_SCHEME, path: `/${sessionId}/${title}` });
}

/** Extracts the session id from one of our URIs. */
export function sessionIdOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== REVISION_SCHEME && uri.scheme !== RESULT_SCHEME) {
        return undefined;
    }
    return uri.path.split('/')[1];
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();

    set(uri: vscode.Uri, text: string): void {
        this.contents.set(uri.toString(), text);
    }

    delete(uri: vscode.Uri): void {
        this.contents.delete(uri.toString());
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }
}

/**
 * Minimal in-memory file system for Result documents. Using a real file system provider (instead of an untitled
 * document) gives the Result a stable URI, a proper title, and normal editor behaviour (undo, save, hot exit prompts).
 */
export class ResultFileSystem implements vscode.FileSystemProvider {
    private readonly files = new Map<string, { data: Uint8Array; ctime: number; mtime: number }>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changeEmitter.event;

    setContent(uri: vscode.Uri, text: string): void {
        const now = Date.now();
        this.files.set(uri.toString(), { data: Buffer.from(text, 'utf8'), ctime: now, mtime: now });
    }

    removeContent(uri: vscode.Uri): void {
        this.files.delete(uri.toString());
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const file = this.get(uri);
        return { type: vscode.FileType.File, ctime: file.ctime, mtime: file.mtime, size: file.data.byteLength };
    }

    readFile(uri: vscode.Uri): Uint8Array {
        return this.get(uri).data;
    }

    writeFile(uri: vscode.Uri, content: Uint8Array): void {
        const existing = this.files.get(uri.toString());
        if (!existing) {
            throw vscode.FileSystemError.NoPermissions(uri);
        }
        this.files.set(uri.toString(), { data: content, ctime: existing.ctime, mtime: Date.now() });
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    rename(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    /** Deleting through the UI is not supported; sessions remove their own content. */
    delete(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    private get(uri: vscode.Uri) {
        const file = this.files.get(uri.toString());
        if (!file) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return file;
    }
}

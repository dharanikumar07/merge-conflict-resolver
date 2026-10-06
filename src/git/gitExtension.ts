import * as vscode from 'vscode';

/** The small subset of the built-in `vscode.git` extension API that we use. */
export interface GitApiRepository {
    readonly rootUri: vscode.Uri;
    readonly state: {
        readonly mergeChanges: readonly { readonly uri: vscode.Uri }[];
        readonly onDidChange: vscode.Event<void>;
    };
}

export interface GitApi {
    readonly repositories: readonly GitApiRepository[];
    readonly onDidOpenRepository: vscode.Event<GitApiRepository>;
    readonly onDidCloseRepository: vscode.Event<GitApiRepository>;
}

export async function getGitApi(): Promise<GitApi | undefined> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    if (!extension) {
        return undefined;
    }
    try {
        const exports = extension.isActive ? extension.exports : await extension.activate();
        return exports.getAPI(1);
    } catch {
        return undefined; // Git disabled or not installed
    }
}

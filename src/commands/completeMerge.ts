import * as path from 'path';
import * as vscode from 'vscode';
import { findConflictMarkerLine } from '../git/GitConflictParser';
import { GitService } from '../git/GitService';
import { MergeSession } from '../editor/MergeSession';
import { SessionManager } from '../editor/SessionManager';
import type { Side } from '../shared/protocol';
import { sessionFromArgs } from './resolveConflict';

/**
 * Writes the Result to the real file, saves it and marks it resolved in Git (`git add`). Never commits.
 * Refuses while conflicts are unresolved; asks before overwriting changes made to the file during the session.
 */
export async function completeMerge(sessions: SessionManager, sessionId?: unknown): Promise<void> {
    const session = sessionFromArgs(sessions, sessionId);
    if (!session) {
        return;
    }
    let reply = await session.request('sync');
    const { stats } = reply.state;

    if (stats.unresolvedConflicts > 0) {
        const choice = await vscode.window.showWarningMessage(
            `${session.fileName} still has ${stats.unresolvedConflicts} unresolved conflict(s).`,
            { modal: true, detail: 'Resolve every conflict before applying: accept (≫ / ≪) or ignore (✕) both of its sides, or edit it in the Result.' },
            'Go to Next Conflict',
        );
        if (choice) {
            await session.request('nextConflict');
        }
        return;
    }

    if (stats.pendingChanges > 0) {
        const APPLY = 'Apply Them and Complete';
        const SKIP = 'Complete Without Them';
        const choice = await vscode.window.showWarningMessage(
            `${stats.pendingChanges} non-conflicting change(s) have not been applied or ignored.`,
            { modal: true, detail: '"Complete Without Them" keeps the Base content for those changes.' },
            APPLY, SKIP,
        );
        if (!choice) {
            return;
        }
        if (choice === APPLY) {
            reply = await session.request('applyNonConflicting');
        }
    }

    const result = reply.result;
    const markerLine = findConflictMarkerLine(result);
    if (markerLine >= 0) {
        const choice = await vscode.window.showWarningMessage(
            `The Result still contains a conflict marker on line ${markerLine + 1}.`,
            { modal: true, detail: 'Remove it, or complete anyway if the marker is intentional content.' },
            'Complete Anyway',
        );
        if (!choice) {
            await session.request('revealLine', { line: markerLine });
            return;
        }
    }

    await finish(sessions, session, result);
}

/** "Accept Left" / "Accept Right": resolves the whole file with one version. */
export async function acceptFile(sessions: SessionManager, session: MergeSession, side: Side): Promise<void> {
    const name = side === 'ours' ? `Yours (${session.source.labels.oursLabel})` : `Theirs (${session.source.labels.theirsLabel})`;
    if (session.state.dirty) {
        const choice = await vscode.window.showWarningMessage(
            `Resolve ${session.fileName} with ${name}?`,
            { modal: true, detail: 'The changes you made in the Result are discarded and the file is replaced with this version.' },
            'Use This Version',
        );
        if (!choice) {
            return;
        }
    }
    await finish(sessions, session, session.source.texts[side]);
}

/** "Cancel": closes the merge editor without touching the file. */
export async function cancelMerge(sessions: SessionManager, session: MergeSession): Promise<void> {
    if (session.state.dirty) {
        const choice = await vscode.window.showWarningMessage(
            `Discard the merge of ${session.fileName}?`,
            { modal: true, detail: 'The changes in the Result are lost. The file stays conflicted.' },
            'Discard',
        );
        if (!choice) {
            return;
        }
    }
    await sessions.close(session);
}

async function finish(sessions: SessionManager, session: MergeSession, result: string): Promise<void> {
    if (!(await writeResult(session, result))) {
        return;
    }
    try {
        await session.source.git?.markResolved(session.source.relativePath);
    } catch (error) {
        void vscode.window.showErrorMessage(`Saved ${session.fileName}, but could not mark it resolved: ${(error as Error).message}`);
        return;
    }
    sessions.completedFiles.add(session.source.fileUri.fsPath);
    await sessions.close(session);
    void offerNextFile(session); // don't keep the command pending while the notification is visible
}

async function writeResult(session: MergeSession, text: string): Promise<boolean> {
    const { fileUri, workingSnapshot } = session.source;
    let doc: vscode.TextDocument | undefined;
    try {
        doc = await vscode.workspace.openTextDocument(fileUri);
    } catch {
        doc = undefined; // file missing in the working tree
    }

    if (doc && workingSnapshot !== undefined && doc.getText() !== workingSnapshot) {
        const choice = await vscode.window.showWarningMessage(
            `${session.fileName} was changed since the merge started.`,
            { modal: true, detail: 'Completing the merge replaces the whole file with the Result. Use "Compare" first if you are unsure.' },
            'Overwrite',
        );
        if (!choice) {
            return false;
        }
    }

    if (!doc) {
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(text, 'utf8'));
        return true;
    }
    // Editing through the document keeps the file's encoding, BOM and line-ending style.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
        void vscode.window.showErrorMessage(`Could not save ${session.fileName}.`);
        return false;
    }
    return true;
}

async function offerNextFile(session: MergeSession): Promise<void> {
    const remaining = session.source.git ? await session.source.git.getConflictedFiles().catch(() => []) : [];
    if (remaining.length === 0) {
        void vscode.window.showInformationMessage(`${session.fileName} merged and marked as resolved. All conflicts resolved — review and commit when ready.`);
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        `${session.fileName} merged and marked as resolved. ${remaining.length} conflicted file(s) remaining.`,
        'Open Next Conflicted File',
    );
    if (choice) {
        await vscode.commands.executeCommand('mergeflow.open', vscode.Uri.file(remaining[0].absolutePath));
    }
}

/** Aborts the in-progress merge/rebase/cherry-pick/revert after an explicit, modal confirmation. */
export async function abortMerge(sessions: SessionManager, sessionId?: unknown): Promise<void> {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : sessions.active();
    const git = session?.source.git ?? await pickRepository();
    if (!git) {
        return;
    }
    const status = await git.getMergeStatus();
    if (status.operation === 'none') {
        void vscode.window.showInformationMessage('No merge, rebase, cherry-pick or revert is in progress.');
        return;
    }
    const command = `git ${status.operation} --abort`;
    const confirm = `Abort ${status.operation[0].toUpperCase()}${status.operation.slice(1)}`;
    const choice = await vscode.window.showWarningMessage(
        `Abort the ${status.operation} in ${path.basename(git.root)}?`,
        {
            modal: true,
            detail: `This runs "${command}". Git discards the ${status.operation} state and resets conflicted files, ` +
                'including any resolutions you have already made. Uncommitted changes in those files may be lost. This cannot be undone from MergeFlow.',
        },
        confirm,
    );
    if (choice !== confirm) {
        return;
    }
    for (const s of sessions.all().filter(s => s.source.git === git)) {
        await sessions.close(s);
    }
    try {
        await git.abort(status.operation);
        void vscode.window.showInformationMessage(`${command} completed.`);
    } catch (error) {
        void vscode.window.showErrorMessage((error as Error).message);
    }
}

async function pickRepository(): Promise<GitService | undefined> {
    const roots: GitService[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            roots.push((await GitService.forFile(vscode.Uri.joinPath(folder.uri, '.probe').fsPath)).git);
        } catch {
            // not a repository
        }
    }
    const unique = [...new Set(roots)];
    if (unique.length <= 1) {
        if (unique.length === 0) {
            void vscode.window.showWarningMessage('No Git repository found in the workspace.');
        }
        return unique[0];
    }
    const picked = await vscode.window.showQuickPick(unique.map(g => ({ label: path.basename(g.root), description: g.root, git: g })), { placeHolder: 'Repository' });
    return picked?.git;
}

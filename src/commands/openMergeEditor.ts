import * as path from 'path';
import * as vscode from 'vscode';
import { parseConflictMarkers } from '../git/GitConflictParser';
import { classifyConflict, ConflictedFile, decodeText, FileVersion, GitService, MergeStatus } from '../git/GitService';
import { detectEol } from '../merge/DiffEngine';
import { MergeModel } from '../merge/MergeModel';
import { SessionManager } from '../editor/SessionManager';

/** Accepts the argument shapes VS Code passes from Explorer, SCM, editor title and our tree view. */
export function uriFromArg(arg: unknown): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    const candidate = arg as { resourceUri?: unknown; uri?: unknown } | undefined;
    if (candidate?.resourceUri instanceof vscode.Uri) {
        return candidate.resourceUri;
    }
    if (candidate?.uri instanceof vscode.Uri) {
        return candidate.uri;
    }
    return undefined;
}

export async function openMergeEditor(sessions: SessionManager, arg?: unknown): Promise<void> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const fileUri = uriFromArg(arg) ?? (activeUri && sessions.forUri(activeUri)?.source.fileUri) ?? activeUri;
    if (!fileUri || fileUri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Merge Resolver: select a conflicted file to open.');
        return;
    }

    const existing = sessions.forFile(fileUri);
    if (existing) {
        await existing.show();
        return;
    }

    const name = path.basename(fileUri.fsPath);
    let git: GitService | undefined;
    let relativePath = name;
    try {
        ({ git, relativePath } = await GitService.forFile(fileUri.fsPath));
    } catch {
        git = undefined; // not in a repository; we can still resolve textual conflict markers
    }

    const conflict = git ? await git.getConflict(relativePath) : undefined;
    if (git && conflict) {
        const type = classifyConflict(conflict.stages);
        if (type !== 'both-modified' && type !== 'both-added') {
            await resolveStructuralConflict(git, conflict, type);
            return;
        }
    }

    const working = await readWorkingDocument(fileUri);
    const versions = git && conflict
        ? await Promise.all([git.getBaseVersion(relativePath), git.getOursVersion(relativePath), git.getTheirsVersion(relativePath)])
        : undefined;

    if (versions?.some(v => v?.binary)) {
        await resolveBinaryConflict(git!, relativePath, name);
        return;
    }

    let texts: { base: string; ours: string; theirs: string };
    if (versions) {
        const [base, ours, theirs] = versions;
        texts = { base: decode(base), ours: decode(ours), theirs: decode(theirs) };
    } else {
        // Not unmerged in the index: fall back to the conflict markers in the file itself.
        const parsed = working ? parseConflictMarkers(working.getText()) : undefined;
        if (!parsed || parsed.conflicts.length === 0) {
            void vscode.window.showInformationMessage(`${name} has no merge conflicts.`);
            return;
        }
        texts = parsed;
    }

    const eol = working ? (working.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n') : detectEol(texts.ours);
    const labels: MergeStatus = git ? await git.getMergeStatus() : { operation: 'none', oursLabel: 'Yours', theirsLabel: 'Theirs' };
    const session = sessions.create({
        fileUri,
        git,
        relativePath,
        model: MergeModel.create(texts.base, texts.ours, texts.theirs, eol),
        labels,
        languageId: working?.languageId ?? 'plaintext',
        workingSnapshot: working?.getText(),
    });

    try {
        await session.show();
    } catch (error) {
        await sessions.close(session);
        throw error;
    }

    if (vscode.workspace.getConfiguration('phpstormMerge').get<boolean>('autoApplyNonConflictingChanges')) {
        await session.applyEdits(session.model.applyNonConflicting('all'));
    }
    const first = session.model.conflicts[0];
    if (first) {
        session.reveal(first);
    } else if (session.model.chunks.length === 0) {
        void vscode.window.showInformationMessage(`Yours and Theirs are identical for ${name}. Use Complete Merge to mark it resolved.`);
    }
    sessions.scheduleRefresh();
}

function decode(version: FileVersion | undefined): string {
    return version ? decodeText(version.content) : '';
}

async function readWorkingDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    try {
        return await vscode.workspace.openTextDocument(uri);
    } catch {
        return undefined; // e.g. deleted in the working tree
    }
}

async function resolveBinaryConflict(git: GitService, relativePath: string, name: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        `${name} cannot be merged as text.`,
        { modal: true, detail: 'Choose which version to keep. The working-tree file will be replaced with that version and marked as resolved.' },
        'Use Yours', 'Use Theirs',
    );
    if (choice) {
        await git.checkoutSide(relativePath, choice === 'Use Yours' ? 'ours' : 'theirs');
        void vscode.window.showInformationMessage(`${name}: kept ${choice === 'Use Yours' ? 'Yours' : 'Theirs'} and marked as resolved.`);
    }
}

/** Conflicts where a side added or deleted the whole file: offer the Git-level choices instead of a text merge. */
async function resolveStructuralConflict(git: GitService, conflict: ConflictedFile, type: ReturnType<typeof classifyConflict>): Promise<void> {
    const name = path.basename(conflict.relativePath);
    const { oursLabel, theirsLabel } = await git.getMergeStatus();
    const KEEP = 'Keep File';
    const DELETE = 'Delete File';
    const descriptions: Partial<Record<typeof type, string>> = {
        'deleted-by-them': `${name} was modified in Yours (${oursLabel}) but deleted in Theirs (${theirsLabel}).`,
        'deleted-by-us': `${name} was deleted in Yours (${oursLabel}) but modified in Theirs (${theirsLabel}).`,
        'both-deleted': `${name} was deleted on both sides (it may have been renamed differently).`,
        'added-by-us': `${name} exists only in Yours (${oursLabel}); this is usually part of a rename conflict.`,
        'added-by-them': `${name} exists only in Theirs (${theirsLabel}); this is usually part of a rename conflict.`,
    };
    const options = type === 'both-deleted' ? [DELETE] : [KEEP, DELETE];
    const choice = await vscode.window.showWarningMessage(descriptions[type] ?? `${name} cannot be merged as text.`, {
        modal: true,
        detail: 'Keep File stages the version currently in the working tree (for "deleted in Yours", Theirs\' version is restored first). Delete File removes it (git rm).',
    }, ...options);
    if (choice === KEEP) {
        if (type === 'deleted-by-us') {
            await git.checkoutSide(conflict.relativePath, 'theirs');
        } else {
            await git.markResolved(conflict.relativePath);
        }
    } else if (choice === DELETE) {
        await git.removeFile(conflict.relativePath);
    }
}

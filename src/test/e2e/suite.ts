/**
 * End-to-end checks that run inside a real VS Code Extension Host (see launch.ts).
 * The workspace is a temporary repository with a conflicted `app.ts` and `notes.txt`.
 */
import * as assert from 'assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MergeResolverApi } from '../../extension';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = probe();
        if (value) {
            return value;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }
        await sleep(50);
    }
}

export async function run(): Promise<void> {
    const results: string[] = [];
    const step = async (name: string, body: () => Promise<void>) => {
        try {
            await body();
            results.push(`ok   ${name}`);
        } catch (error) {
            results.push(`FAIL ${name}: ${(error as Error).stack}`);
            throw error;
        } finally {
            fs.writeFileSync(process.env.E2E_REPORT!, results.join('\n') + '\n');
        }
    };

    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const fileUri = vscode.Uri.file(path.join(root, 'app.ts'));
    const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'phpstorm-merge-extension')!;
    const api = (extension.isActive ? extension.exports : await extension.activate()) as MergeResolverApi;

    await step('opens three side-by-side panes: Yours | Result | Theirs', async () => {
        await vscode.commands.executeCommand('phpstorm-merge.open', fileUri);
        const session = await waitFor('session', () => api.sessions.forFile(fileUri)?.ready && api.sessions.forFile(fileUri));
        assert.equal(vscode.window.tabGroups.all.length, 3);
        const byColumn = (col: vscode.ViewColumn) => vscode.window.visibleTextEditors.find(e => e.viewColumn === col)?.document.uri.toString();
        assert.equal(byColumn(vscode.ViewColumn.One), session.uris.ours.toString());
        assert.equal(byColumn(vscode.ViewColumn.Two), session.uris.result.toString());
        assert.equal(byColumn(vscode.ViewColumn.Three), session.uris.theirs.toString());
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), session.uris.result.toString(), 'Result is focused');
        assert.equal(vscode.window.activeTextEditor?.document.languageId, 'typescript', 'syntax highlighting language');
        assert.equal(session.source.labels.oursLabel, 'main');
        assert.equal(session.source.labels.theirsLabel, 'feature');
        assert.deepEqual(session.model.chunks.map(c => c.kind), ['ours', 'conflict', 'theirs', 'conflict']);
    });

    const session = api.sessions.forFile(fileUri)!;
    const resultDoc = () => session.resultDocument!;

    await step('Yours and Theirs panes are read-only', async () => {
        for (const [uri, column] of [[session.uris.ours, vscode.ViewColumn.One], [session.uris.theirs, vscode.ViewColumn.Three]] as const) {
            const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { viewColumn: column });
            const before = editor.document.getText();
            await vscode.commands.executeCommand('type', { text: 'typed by user' });
            await vscode.commands.executeCommand('deleteLeft');
            assert.equal(editor.document.getText(), before);
            assert.equal(editor.document.isDirty, false);
        }
        // Return focus to the Result with the cursor in the first conflict, as after opening.
        await vscode.window.showTextDocument(resultDoc(), { viewColumn: vscode.ViewColumn.Two });
        session.reveal(session.model.conflicts[0]);
    });

    await step('CodeLens actions are offered in all three panes', async () => {
        const titles = async (uri: vscode.Uri) =>
            ((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? []).map(l => l.command?.title ?? '');
        const result = await titles(session.uris.result);
        assert.ok(result.some(t => t.includes('Conflict 1 of 2')), result.join(' | '));
        assert.ok(result.includes('Accept Yours') && result.includes('Accept Theirs'));
        assert.ok(result.some(t => t.includes('Resolve Simple')), 'conflict 2 is simple');
        assert.ok((await titles(session.uris.ours)).includes('$(arrow-right) Accept'));
        assert.ok((await titles(session.uris.theirs)).includes('$(arrow-left) Accept'));
    });

    await step('apply non-conflicting changes', async () => {
        await vscode.commands.executeCommand('phpstorm-merge.applyNonConflicting', session.id);
        const text = resultDoc().getText();
        assert.ok(text.includes('import { log } from "./log";'), text);
        assert.ok(text.includes('export const VERSION = 2;'), text);
        assert.equal(session.model.stats().pendingChanges, 0);
    });

    await step('Accept Yours on the conflict under the cursor (opened at the first conflict)', async () => {
        await vscode.commands.executeCommand('phpstorm-merge.acceptYours');
        assert.ok(resultDoc().getText().includes('return "hello from main";'));
        assert.equal(session.model.conflicts[0].resolved, true);
    });

    await step('undo restores the conflict; next conflict navigation; status updates', async () => {
        await vscode.commands.executeCommand('undo');
        await waitFor('undo applied', () => !session.model.conflicts[0].resolved);
        assert.ok(!resultDoc().getText().includes('hello from main'));
        await vscode.commands.executeCommand('redo');
        await waitFor('redo applied', () => session.model.conflicts[0].resolved);
        await vscode.commands.executeCommand('phpstorm-merge.nextConflict');
        assert.equal(session.currentChunkId, session.model.conflicts[1].id);
    });

    await step('Accept Theirs, then Revert Resolution, then Resolve Simple', async () => {
        const second = session.model.conflicts[1];
        await vscode.commands.executeCommand('phpstorm-merge.acceptTheirs', session.id, second.id);
        assert.equal(second.resolved, true);
        await vscode.commands.executeCommand('phpstorm-merge.revertResolution', session.id, second.id);
        assert.equal(second.resolved, false);
        await vscode.commands.executeCommand('phpstorm-merge.resolveSimple', session.id, second.id);
        assert.ok(resultDoc().getText().includes('const greeting = "Hello, World!!" + suffix.trim();'), resultDoc().getText());
    });

    await step('manual typing inside a conflict resolves it', async () => {
        await vscode.commands.executeCommand('phpstorm-merge.revertResolution', session.id, session.model.conflicts[0].id);
        const first = session.model.conflicts[0];
        const doc = resultDoc();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(first.start), doc.positionAt(first.end)), '    return "hand-merged";\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await waitFor('manual edit tracked', () => first.edited);
        assert.equal(session.model.stats().unresolvedConflicts, 0);
    });

    await step('re-opening an in-progress file returns to the same session', async () => {
        const text = resultDoc().getText();
        await vscode.commands.executeCommand('phpstorm-merge.open', fileUri);
        assert.equal(api.sessions.forFile(fileUri), session);
        assert.equal(resultDoc().getText(), text);
    });

    await step('Complete Merge writes the real file, stages it, does not commit', async () => {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
        const expected = resultDoc().getText();
        await vscode.commands.executeCommand('phpstorm-merge.completeMerge', session.id);
        assert.equal(fs.readFileSync(fileUri.fsPath, 'utf8'), expected);
        const unmerged = execFileSync('git', ['ls-files', '-u'], { cwd: root, encoding: 'utf8' });
        assert.ok(!unmerged.includes('app.ts'), unmerged);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }), head);
        await waitFor('session closed', () => !api.sessions.forFile(fileUri));
        assert.ok(!vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputText && t.input.uri.scheme.startsWith('phpmerge')));
    });

    await step('closing the Result tab ends the session without touching the file', async () => {
        const notes = vscode.Uri.file(path.join(root, 'notes.txt'));
        const before = fs.readFileSync(notes.fsPath, 'utf8');
        await vscode.commands.executeCommand('phpstorm-merge.open', notes);
        const s = await waitFor('notes session', () => api.sessions.forFile(notes)?.ready && api.sessions.forFile(notes));
        await vscode.commands.executeCommand('phpstorm-merge.acceptTheirs');
        const tab = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === s.uris.result.toString())!;
        await s.resultDocument!.save(); // avoid the "save changes?" prompt in the test
        await vscode.window.tabGroups.close(tab);
        await waitFor('session disposed', () => !api.sessions.forFile(notes));
        assert.equal(fs.readFileSync(notes.fsPath, 'utf8'), before);
    });
}

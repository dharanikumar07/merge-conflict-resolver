/**
 * End-to-end checks that run inside a real VS Code Extension Host (see launch.ts).
 * The workspace is a temporary repository with a conflicted `app.ts` and `notes.txt`.
 */
import * as assert from 'assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { acceptFile, cancelMerge } from '../../commands/completeMerge';
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
    const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'mergeflow')!;
    const api = (extension.isActive ? extension.exports : await extension.activate()) as MergeResolverApi;

    await step('opens the MergeFlow merge editor (webview) for the file', async () => {
        await vscode.commands.executeCommand('mergeflow.open', fileUri);
        const session = await waitFor('session', () => api.sessions.forFile(fileUri)?.ready && api.sessions.forFile(fileUri), 15000);
        const reply = await session.request('sync'); // proves the webview script, Monaco and the model loaded
        assert.equal(session.active, true, 'merge panel is focused');
        assert.equal(session.source.labels.oursLabel, 'main');
        assert.equal(session.source.labels.theirsLabel, 'feature');
        assert.equal(session.source.languageId, 'typescript');
        assert.deepEqual(reply.chunks.map(c => c.kind), ['ours', 'conflict', 'theirs', 'conflict']);
        assert.equal(reply.result, session.source.texts.base, 'Result starts as Base');
        assert.equal(reply.state.stats.unresolvedConflicts, 2);
    });

    const session = api.sessions.forFile(fileUri)!;
    const conflictIds = (await session.request('sync')).chunks.filter(c => c.kind === 'conflict').map(c => c.id);

    await step('apply non-conflicting changes', async () => {
        await vscode.commands.executeCommand('mergeflow.applyNonConflicting', session.id);
        const reply = await session.request('sync');
        assert.ok(reply.result.includes('import { log } from "./log";'), reply.result);
        assert.ok(reply.result.includes('export const VERSION = 2;'), reply.result);
        assert.equal(reply.state.stats.pendingChanges, 0);
    });

    await step('accepting one side keeps the other side pending until it is ignored', async () => {
        const [first] = conflictIds;
        await vscode.commands.executeCommand('mergeflow.acceptYours', session.id, first);
        let reply = await session.request('sync');
        let chunk = reply.chunks.find(c => c.id === first)!;
        assert.ok(reply.result.includes('return "hello from main";'));
        assert.equal(chunk.ours, 'applied');
        assert.equal(chunk.theirs, 'pending', 'the right arrow stays');
        assert.equal(chunk.resolved, false);
        await vscode.commands.executeCommand('mergeflow.ignoreTheirs', session.id, first);
        reply = await session.request('sync');
        chunk = reply.chunks.find(c => c.id === first)!;
        assert.equal(chunk.resolved, true);
        assert.equal(reply.state.stats.unresolvedConflicts, 1);
    });

    await step('accepting the other side appends it; revert; resolve simple', async () => {
        const second = conflictIds[1];
        await vscode.commands.executeCommand('mergeflow.acceptTheirs', session.id, second);
        let reply = await session.request('acceptYours', { chunkId: second });
        assert.ok(reply.result.includes('    const greeting = "Hello, World" + suffix.trim();\n    const greeting = "Hello, World!!" + suffix;\n'), reply.result);
        assert.equal(reply.chunks.find(c => c.id === second)!.resolved, true);
        await vscode.commands.executeCommand('mergeflow.revertResolution', session.id, second);
        reply = await session.request('sync');
        assert.equal(reply.chunks.find(c => c.id === second)!.resolved, false);
        await vscode.commands.executeCommand('mergeflow.resolveSimple', session.id, second);
        reply = await session.request('sync');
        assert.ok(reply.result.includes('const greeting = "Hello, World!!" + suffix.trim();'), reply.result);
        assert.equal(reply.state.stats.unresolvedConflicts, 0);
    });

    await step('commands without arguments act on the focused merge editor', async () => {
        await vscode.commands.executeCommand('mergeflow.revertResolution', session.id, conflictIds[0]);
        await vscode.commands.executeCommand('mergeflow.nextConflict');
        const reply = await session.request('sync');
        assert.equal(reply.state.currentConflict, 1);
        await vscode.commands.executeCommand('mergeflow.acceptTheirs');
        await vscode.commands.executeCommand('mergeflow.ignoreYours');
        const after = await session.request('sync');
        assert.ok(after.result.includes('return "hello from feature";'), after.result);
        assert.equal(after.state.stats.unresolvedConflicts, 0);
    });

    await step('re-opening an in-progress file returns to the same session', async () => {
        const text = await session.resultText();
        await vscode.commands.executeCommand('mergeflow.open', fileUri);
        assert.equal(api.sessions.forFile(fileUri), session);
        assert.equal(await session.resultText(), text);
    });

    await step('Compare opens a VS Code diff with a snapshot of the Result', async () => {
        await vscode.commands.executeCommand('mergeflow.compareResultBase');
        const diff = await waitFor('diff tab', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff
            && vscode.window.tabGroups.activeTabGroup.activeTab.input as vscode.TabInputTextDiff);
        const doc = await vscode.workspace.openTextDocument(diff.modified);
        assert.equal(doc.getText(), await session.resultText());
        session.show();
        await waitFor('merge panel focused', () => session.active);
    });

    await step('Apply (Complete Merge) writes the real file, stages it, does not commit', async () => {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
        const expected = await session.resultText();
        await vscode.commands.executeCommand('mergeflow.completeMerge', session.id);
        assert.equal(fs.readFileSync(fileUri.fsPath, 'utf8'), expected);
        const unmerged = execFileSync('git', ['ls-files', '-u'], { cwd: root, encoding: 'utf8' });
        assert.ok(!unmerged.includes('app.ts'), unmerged);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }), head);
        await waitFor('session closed', () => !api.sessions.forFile(fileUri));
        assert.ok(!vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputWebview));
    });

    await step('Cancel closes the merge editor without touching the file', async () => {
        const notes = vscode.Uri.file(path.join(root, 'notes.txt'));
        const before = fs.readFileSync(notes.fsPath, 'utf8');
        await vscode.commands.executeCommand('mergeflow.open', notes);
        const s = await waitFor('notes session', () => api.sessions.forFile(notes)?.ready && api.sessions.forFile(notes), 15000);
        await s.request('sync');
        await cancelMerge(api.sessions, s); // Result unchanged, so no confirmation
        await waitFor('session disposed', () => !api.sessions.forFile(notes));
        assert.equal(fs.readFileSync(notes.fsPath, 'utf8'), before);
    });

    await step('Accept Right resolves the whole file with Theirs and stages it', async () => {
        const notes = vscode.Uri.file(path.join(root, 'notes.txt'));
        await vscode.commands.executeCommand('mergeflow.open', notes);
        const s = await waitFor('notes session', () => api.sessions.forFile(notes)?.ready && api.sessions.forFile(notes), 15000);
        await s.request('sync');
        await acceptFile(api.sessions, s, 'theirs');
        assert.equal(fs.readFileSync(notes.fsPath, 'utf8'), 'shared\nline theirs\n');
        const unmerged = execFileSync('git', ['ls-files', '-u'], { cwd: root, encoding: 'utf8' });
        assert.ok(!unmerged.includes('notes.txt'), unmerged);
        await waitFor('session disposed', () => !api.sessions.forFile(notes));
    });
}

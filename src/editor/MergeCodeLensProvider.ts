import * as vscode from 'vscode';
import { MergeChunk } from '../merge/MergeChunk';
import { MergeSession, PaneRole } from './MergeSession';
import { SessionManager } from './SessionManager';

/**
 * Inline actions above each change, mirroring PhpStorm's gutter arrows:
 *   Yours:  [→ Accept] [✕ Ignore]        Theirs: [← Accept] [✕ Ignore]
 *   Result: Conflict 2 of 5: Accept Yours | Accept Theirs | Accept Both | Resolve Simple
 */
export class MergeCodeLensProvider implements vscode.CodeLensProvider {
    readonly onDidChangeCodeLenses: vscode.Event<void>;

    constructor(private readonly sessions: SessionManager) {
        this.onDidChangeCodeLenses = sessions.onDidChange;
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const session = this.sessions.forUri(document.uri);
        const role = session?.roleOf(document.uri);
        if (!session || !role || role === 'base') {
            return [];
        }
        const lenses = [...this.header(session, role)];
        const conflicts = session.model.conflicts;
        for (const chunk of session.model.chunks) {
            const line = Math.min(session.chunkLines(chunk, role).start, document.lineCount - 1);
            const range = new vscode.Range(line, 0, line, 0);
            const lens = (title: string, command = '', tooltip?: string) =>
                new vscode.CodeLens(range, { title, command, tooltip, arguments: command ? [session.id, chunk.id] : undefined });
            const label = chunk.isConflict ? `Conflict ${conflicts.indexOf(chunk) + 1} of ${conflicts.length}` : undefined;

            if (role === 'result') {
                lenses.push(...this.resultLenses(chunk, label, lens));
            } else if (chunk.state(role) === 'pending' && !chunk.edited) {
                const accept = role === 'ours' ? 'phpstorm-merge.acceptYours' : 'phpstorm-merge.acceptTheirs';
                const ignore = role === 'ours' ? 'phpstorm-merge.ignoreYours' : 'phpstorm-merge.ignoreTheirs';
                const arrow = role === 'ours' ? '$(arrow-right) Accept' : '$(arrow-left) Accept';
                if (label) {
                    lenses.push(lens(`$(warning) ${label}`));
                }
                lenses.push(lens(arrow, accept, `Copy this change into the Result`), lens('$(close) Ignore', ignore, 'Keep the Result as it is for this change'));
            }
        }
        return lenses;
    }

    private resultLenses(chunk: MergeChunk, label: string | undefined, lens: (title: string, command?: string, tooltip?: string) => vscode.CodeLens): vscode.CodeLens[] {
        if (chunk.resolved) {
            return chunk.isConflict || chunk.edited
                ? [lens(`$(check) ${label ?? 'Change'} resolved${chunk.edited ? ' manually' : ''}`), lens('$(discard) Revert', 'phpstorm-merge.revertResolution', 'Restore this conflict to its unresolved state')]
                : [];
        }
        if (!chunk.isConflict) {
            const from = chunk.kind === 'theirs' ? 'Theirs' : chunk.kind === 'ours' ? 'Yours' : 'both sides';
            const accept = chunk.kind === 'theirs' ? 'phpstorm-merge.acceptTheirs' : 'phpstorm-merge.acceptYours';
            const ignore = chunk.kind === 'theirs' ? 'phpstorm-merge.ignoreTheirs' : 'phpstorm-merge.ignoreYours';
            return [lens(`Change from ${from}:`), lens('Apply', accept), lens('Ignore', ignore)];
        }
        const lenses = [lens(`$(warning) ${label}:`)];
        if (chunk.oursState === 'pending') {
            lenses.push(lens('Accept Yours', 'phpstorm-merge.acceptYours'));
        }
        if (chunk.theirsState === 'pending') {
            lenses.push(lens('Accept Theirs', 'phpstorm-merge.acceptTheirs'));
        }
        if (chunk.oursState === 'pending' && chunk.theirsState === 'pending') {
            lenses.push(lens('Accept Both', 'phpstorm-merge.acceptBoth', 'Yours followed by Theirs'));
            if (chunk.simpleResolution !== undefined) {
                lenses.push(lens('$(wand) Resolve Simple', 'phpstorm-merge.resolveSimple', 'Both sides changed different parts; combine them'));
            }
        } else {
            const ignore = chunk.oursState === 'pending' ? 'phpstorm-merge.ignoreYours' : 'phpstorm-merge.ignoreTheirs';
            lenses.push(lens('Ignore', ignore));
        }
        return lenses;
    }

    private header(session: MergeSession, role: PaneRole): vscode.CodeLens[] {
        const range = new vscode.Range(0, 0, 0, 0);
        const { labels } = session.source;
        if (role === 'ours') {
            return [new vscode.CodeLens(range, { title: `YOURS · ${labels.oursLabel} · read-only`, command: '' })];
        }
        if (role === 'theirs') {
            return [new vscode.CodeLens(range, { title: `THEIRS · ${labels.theirsLabel} · read-only`, command: '' })];
        }
        const stats = session.model.stats();
        const lenses = [new vscode.CodeLens(range, {
            title: stats.unresolvedConflicts > 0 ? `RESULT · ${stats.unresolvedConflicts} of ${stats.conflicts} conflicts unresolved` : 'RESULT · all conflicts resolved',
            command: '',
        })];
        if (stats.pendingChanges > 0) {
            lenses.push(new vscode.CodeLens(range, { title: `$(check-all) Apply ${stats.pendingChanges} non-conflicting change(s)`, command: 'phpstorm-merge.applyNonConflicting', arguments: [session.id] }));
        }
        if (stats.unresolvedConflicts === 0) {
            lenses.push(new vscode.CodeLens(range, { title: '$(check) Complete Merge', command: 'phpstorm-merge.completeMerge', arguments: [session.id] }));
        }
        return lenses;
    }
}

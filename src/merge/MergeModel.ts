import { normalizeEol, splitLines } from './DiffEngine';
import { MergeChunk, Side, SideState } from './MergeChunk';
import { IndexRange, merge3, resolveSimpleConflict } from './MergeEngine';

/** A replacement in the result document, in offsets of the document's current text. */
export interface ResultEdit {
    start: number;
    end: number;
    text: string;
}

/** Mirrors vscode.TextDocumentContentChangeEvent (offset-based). */
export interface ContentChange {
    rangeOffset: number;
    rangeLength: number;
    text: string;
}

export interface MergeStats {
    conflicts: number;
    unresolvedConflicts: number;
    /** Non-conflicting changes the user has not applied or ignored yet. */
    pendingChanges: number;
    changes: number;
}

export type ApplyFilter = 'ours' | 'theirs' | 'all';

/**
 * The complete merge state of one file: the three input versions, the list of changed chunks, and where each chunk
 * currently lives in the (editable) result document. Free of any VS Code dependency so it can be unit-tested.
 *
 * The result starts as the base version, like in PhpStorm; changes from either side are then applied into it.
 */
export class MergeModel {
    readonly chunks: MergeChunk[];
    readonly initialResult: string;
    /** Length of the result document, tracked through changes. */
    private resultLength: number;

    private constructor(
        readonly base: string,
        readonly ours: string,
        readonly theirs: string,
        readonly eol: '\n' | '\r\n',
    ) {
        const baseLines = splitLines(base);
        const oursLines = splitLines(ours);
        const theirsLines = splitLines(theirs);
        const slice = (lines: string[], r: IndexRange) => lines.slice(r.start, r.end).join('');

        this.chunks = [];
        let offset = 0;
        for (const block of merge3(baseLines, oursLines, theirsLines)) {
            const baseText = slice(baseLines, block.base);
            if (block.kind !== 'unchanged') {
                const oursText = slice(oursLines, block.ours);
                const theirsText = slice(theirsLines, block.theirs);
                const chunk = new MergeChunk(
                    this.chunks.length, block.kind, block.base, block.ours, block.theirs,
                    baseText, oursText, theirsText,
                    block.kind === 'conflict' ? resolveSimpleConflict(baseText, oursText, theirsText) : undefined,
                );
                chunk.start = offset;
                chunk.end = offset + baseText.length;
                this.chunks.push(chunk);
            }
            offset += baseText.length;
        }
        this.initialResult = base;
        this.resultLength = base.length;
    }

    /** All texts are normalized to `eol` so line splitting and offsets agree with the editor documents. */
    static create(base: string, ours: string, theirs: string, eol: '\n' | '\r\n'): MergeModel {
        return new MergeModel(normalizeEol(base, eol), normalizeEol(ours, eol), normalizeEol(theirs, eol), eol);
    }

    get conflicts(): MergeChunk[] {
        return this.chunks.filter(c => c.isConflict);
    }

    chunk(id: number): MergeChunk | undefined {
        return this.chunks[id];
    }

    stats(): MergeStats {
        let conflicts = 0;
        let unresolvedConflicts = 0;
        let pendingChanges = 0;
        for (const c of this.chunks) {
            if (c.isConflict) {
                conflicts++;
                if (!c.resolved) {
                    unresolvedConflicts++;
                }
            } else if (!c.resolved) {
                pendingChanges++;
            }
        }
        return { conflicts, unresolvedConflicts, pendingChanges, changes: this.chunks.length };
    }

    /** The chunk whose result region contains `offset` (an empty region matches only its exact position). */
    chunkAtOffset(offset: number): MergeChunk | undefined {
        return this.chunks.find(c => (c.start <= offset && offset < c.end) || (c.start === c.end && c.start === offset));
    }

    /** The chunk covering `line` in one of the read-only versions. */
    chunkAtLine(side: Side | 'base', line: number): MergeChunk | undefined {
        return this.chunks.find(c => {
            const r = c.sideLines(side);
            return (r.start <= line && line < r.end) || (r.start === r.end && r.start === line);
        });
    }

    // ---- Actions. Each returns the edit to apply to the result document (if any) and updates chunk state. ----

    /** Accept one side's change. For a conflict, this resolves it (the other side is ignored). */
    accept(chunk: MergeChunk, side: Side): ResultEdit | undefined {
        if (chunk.state(side) === 'none') {
            return undefined;
        }
        if (chunk.kind === 'both') {
            return this.plan(chunk, chunk.oursText, 'applied', 'applied');
        }
        const other: Side = side === 'ours' ? 'theirs' : 'ours';
        const otherState: SideState = chunk.state(other) === 'pending' ? 'ignored' : chunk.state(other);
        return side === 'ours'
            ? this.plan(chunk, chunk.oursText, 'applied', otherState)
            : this.plan(chunk, chunk.theirsText, otherState, 'applied');
    }

    /** Accept both sides of a conflict: Yours followed by Theirs. */
    acceptBoth(chunk: MergeChunk, first: Side = 'ours'): ResultEdit | undefined {
        if (!chunk.isConflict) {
            return this.accept(chunk, first);
        }
        const [a, b] = first === 'ours' ? [chunk.oursText, chunk.theirsText] : [chunk.theirsText, chunk.oursText];
        const joined = a.length > 0 && !a.endsWith('\n') && b.length > 0 ? a + this.eol + b : a + b;
        return this.plan(chunk, joined, 'applied', 'applied');
    }

    /** Ignore one side's change: the result region keeps its current content (`currentText`). */
    ignore(chunk: MergeChunk, side: Side, currentText: string): void {
        if (chunk.state(side) !== 'pending') {
            return;
        }
        if (chunk.kind === 'both') {
            chunk.setState(currentText, 'ignored', 'ignored'); // the same change on both sides
        } else if (side === 'ours') {
            chunk.setState(currentText, 'ignored', chunk.theirsState);
        } else {
            chunk.setState(currentText, chunk.oursState, 'ignored');
        }
    }

    /** Combine both sides automatically when they touched different words. Returns undefined if not possible. */
    resolveSimple(chunk: MergeChunk): ResultEdit | undefined {
        if (!chunk.isConflict || chunk.simpleResolution === undefined) {
            return undefined;
        }
        return this.plan(chunk, chunk.simpleResolution, 'applied', 'applied');
    }

    /** Restore the chunk to its initial, unresolved state (base content in the result). */
    revert(chunk: MergeChunk): ResultEdit | undefined {
        chunk.reset();
        return this.edit(chunk, chunk.baseText);
    }

    /** Apply every pending non-conflicting change (optionally only those coming from one side). */
    applyNonConflicting(filter: ApplyFilter): ResultEdit[] {
        const edits: ResultEdit[] = [];
        for (const chunk of this.chunks) {
            if (chunk.isConflict || chunk.resolved) {
                continue;
            }
            const side: Side = chunk.kind === 'theirs' ? 'theirs' : 'ours';
            if (filter === 'all' || chunk.kind === filter || chunk.kind === 'both') {
                const edit = this.accept(chunk, side);
                if (edit) {
                    edits.push(edit);
                }
            }
        }
        return edits;
    }

    // ---- Document synchronization ----

    /**
     * Updates chunk positions for edits made to the result document (by us, by the user, or by undo/redo), then
     * re-derives the state of every chunk the edits touched.
     */
    handleDocumentChange(changes: readonly ContentChange[], getText: (start: number, end: number) => string): void {
        const touched = new Set<MergeChunk>();
        // Apply from the end of the document backwards so earlier offsets stay valid.
        const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
        for (const change of sorted) {
            const s = change.rangeOffset;
            const e = s + change.rangeLength;
            const delta = change.text.length - change.rangeLength;
            const atEnd = e === this.resultLength;
            this.resultLength += delta;
            for (const c of this.chunks) {
                if (e < c.start || (e === c.start && s < c.start)) {
                    c.start += delta;
                    c.end += delta;
                } else if (s > c.end || (s === c.end && (c.start !== c.end || !insertsWholeLines(change, atEnd)))) {
                    // After the region. An empty region (pure insertion point at a line start) only absorbs
                    // insertions of whole lines; typing at the start of the following line is not inside it.
                } else {
                    c.start = Math.min(c.start, s);
                    c.end = Math.max(c.end, e) + delta;
                    touched.add(c);
                }
            }
        }
        for (const c of touched) {
            c.syncWithText(getText(c.start, c.end));
        }
    }

    private plan(chunk: MergeChunk, text: string, ours: SideState, theirs: SideState): ResultEdit | undefined {
        chunk.setState(text, ours, theirs);
        return this.edit(chunk, text);
    }

    private edit(chunk: MergeChunk, text: string): ResultEdit {
        return { start: chunk.start, end: chunk.end, text };
    }
}

function insertsWholeLines(change: ContentChange, atDocumentEnd: boolean): boolean {
    return change.rangeLength === 0 && (change.text.endsWith('\n') || atDocumentEnd);
}

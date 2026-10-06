import { diffHunks, Hunk } from './DiffEngine';

export type BlockKind = 'unchanged' | 'ours' | 'theirs' | 'both' | 'conflict';

export interface IndexRange {
    start: number;
    end: number;
}

/** One block of a three-way merge, with the corresponding ranges in each version. */
export interface MergeBlock {
    kind: BlockKind;
    base: IndexRange;
    ours: IndexRange;
    theirs: IndexRange;
}

interface TaggedHunk {
    hunk: Hunk;
    side: 'ours' | 'theirs';
}

/**
 * Classic diff3: diff base→ours and base→theirs, then group hunks whose base ranges overlap or touch.
 * A group touched by only one side is a non-conflicting change; a group touched by both sides is a
 * conflict unless both sides produced identical content.
 */
export function merge3<T>(base: readonly T[], ours: readonly T[], theirs: readonly T[]): MergeBlock[] {
    const tagged: TaggedHunk[] = [
        ...diffHunks(base, ours).map(hunk => ({ hunk, side: 'ours' as const })),
        ...diffHunks(base, theirs).map(hunk => ({ hunk, side: 'theirs' as const })),
    ].sort((a, b) => a.hunk.baseStart - b.hunk.baseStart || a.hunk.baseEnd - b.hunk.baseEnd);

    const blocks: MergeBlock[] = [];
    let basePos = 0;
    let oursPos = 0;
    let theirsPos = 0;

    const pushUnchanged = (until: number) => {
        if (until > basePos) {
            const len = until - basePos;
            blocks.push({
                kind: 'unchanged',
                base: { start: basePos, end: until },
                ours: { start: oursPos, end: oursPos + len },
                theirs: { start: theirsPos, end: theirsPos + len },
            });
            oursPos += len;
            theirsPos += len;
            basePos = until;
        }
    };

    let i = 0;
    while (i < tagged.length) {
        const clusterStart = tagged[i].hunk.baseStart;
        let clusterEnd = tagged[i].hunk.baseEnd;
        const members: TaggedHunk[] = [tagged[i++]];
        // Touching hunks (start === end) are grouped too: edits to adjacent lines are treated as conflicting, like Git.
        while (i < tagged.length && tagged[i].hunk.baseStart <= clusterEnd) {
            clusterEnd = Math.max(clusterEnd, tagged[i].hunk.baseEnd);
            members.push(tagged[i++]);
        }

        pushUnchanged(clusterStart);
        const oursRange = sideRange(members, 'ours', clusterStart, clusterEnd, oursPos);
        const theirsRange = sideRange(members, 'theirs', clusterStart, clusterEnd, theirsPos);
        const touchedByOurs = members.some(m => m.side === 'ours');
        const touchedByTheirs = members.some(m => m.side === 'theirs');

        let kind: BlockKind;
        if (touchedByOurs && touchedByTheirs) {
            kind = rangesEqual(ours, oursRange, theirs, theirsRange) ? 'both' : 'conflict';
        } else {
            kind = touchedByOurs ? 'ours' : 'theirs';
        }
        blocks.push({ kind, base: { start: clusterStart, end: clusterEnd }, ours: oursRange, theirs: theirsRange });
        basePos = clusterEnd;
        oursPos = oursRange.end;
        theirsPos = theirsRange.end;
    }
    pushUnchanged(base.length);
    return blocks;
}

function sideRange(members: TaggedHunk[], side: 'ours' | 'theirs', clusterStart: number, clusterEnd: number, sidePos: number): IndexRange {
    const own = members.filter(m => m.side === side);
    if (own.length === 0) {
        return { start: sidePos, end: sidePos + (clusterEnd - clusterStart) };
    }
    const last = own[own.length - 1].hunk;
    return { start: sidePos, end: last.sideEnd + (clusterEnd - last.baseEnd) };
}

function rangesEqual<T>(a: readonly T[], ra: IndexRange, b: readonly T[], rb: IndexRange): boolean {
    if (ra.end - ra.start !== rb.end - rb.start) {
        return false;
    }
    for (let k = 0; k < ra.end - ra.start; k++) {
        if (a[ra.start + k] !== b[rb.start + k]) {
            return false;
        }
    }
    return true;
}

// Newlines, runs of other whitespace, words, and single punctuation characters.
const TOKEN_REGEX = /\r\n|\n|[^\S\r\n]+|[\p{L}\p{N}_]+|[^]/gu;
const MAX_SIMPLE_TOKENS = 50_000;

/**
 * "Resolve simple conflict": re-runs the three-way merge on word-level tokens.
 * Returns the combined text when both sides changed different parts of the region, or undefined when the
 * changes still overlap (in which case the conflict must stay unresolved).
 */
export function resolveSimpleConflict(base: string, ours: string, theirs: string): string | undefined {
    const baseTokens = base.match(TOKEN_REGEX) ?? [];
    const oursTokens = ours.match(TOKEN_REGEX) ?? [];
    const theirsTokens = theirs.match(TOKEN_REGEX) ?? [];
    if (baseTokens.length + oursTokens.length + theirsTokens.length > MAX_SIMPLE_TOKENS) {
        return undefined;
    }
    const blocks = merge3(baseTokens, oursTokens, theirsTokens);
    if (blocks.some(b => b.kind === 'conflict')) {
        return undefined;
    }
    let result = '';
    for (const block of blocks) {
        const [tokens, range] = block.kind === 'theirs' ? [theirsTokens, block.theirs]
            : block.kind === 'unchanged' ? [baseTokens, block.base]
            : [oursTokens, block.ours];
        result += tokens.slice(range.start, range.end).join('');
    }
    return result;
}

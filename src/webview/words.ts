import { diffWordsWithSpace } from 'diff';

/** Offsets relative to the compared strings. */
export interface WordRange {
    start: number;
    end: number;
}

export interface WordDiff {
    /** Words of `a` that are not in `b`. */
    inA: WordRange[];
    /** Words of `b` that are not in `a`. */
    inB: WordRange[];
}

const MAX_LENGTH = 20_000;
const TIMEOUT_MS = 150;
const MAX_CACHE = 400;
const cache = new Map<string, WordDiff | undefined>();

/** Word-level differences between two versions of a change, for "Highlight words". Cached; undefined if too large. */
export function wordDiff(a: string, b: string): WordDiff | undefined {
    if (a === b) {
        return { inA: [], inB: [] };
    }
    if (a.length + b.length > MAX_LENGTH) {
        return undefined;
    }
    const key = `${a}\u0000${b}`;
    if (cache.has(key)) {
        return cache.get(key);
    }
    const result = compute(a, b);
    if (cache.size >= MAX_CACHE) {
        cache.clear();
    }
    cache.set(key, result);
    return result;
}

function compute(a: string, b: string): WordDiff | undefined {
    const parts = diffWordsWithSpace(a, b, { timeout: TIMEOUT_MS });
    if (!parts) {
        return undefined;
    }
    const diff: WordDiff = { inA: [], inB: [] };
    let posA = 0;
    let posB = 0;
    for (const part of parts) {
        const length = part.value.length;
        const visible = part.value.trim().length > 0;
        if (part.added) {
            if (visible) {
                diff.inB.push({ start: posB, end: posB + length });
            }
            posB += length;
        } else if (part.removed) {
            if (visible) {
                diff.inA.push({ start: posA, end: posA + length });
            }
            posA += length;
        } else {
            posA += length;
            posB += length;
        }
    }
    return diff;
}

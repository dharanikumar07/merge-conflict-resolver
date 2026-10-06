import { diffArrays } from 'diff';

/** A changed region: base[baseStart, baseEnd) was replaced by side[sideStart, sideEnd). */
export interface Hunk {
    baseStart: number;
    baseEnd: number;
    sideStart: number;
    sideEnd: number;
}

const DIFF_TIMEOUT_MS = 3000;

/** Splits text into lines, keeping each line's terminator so slices can be re-joined losslessly. */
export function splitLines(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) {
            lines.push(text.slice(start, i + 1));
            start = i + 1;
        }
    }
    if (start < text.length) {
        lines.push(text.slice(start));
    }
    return lines;
}

export function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
    return text.replace(/\r\n|\r|\n/g, eol);
}

export function detectEol(text: string): '\n' | '\r\n' {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    return crlf > lf ? '\r\n' : '\n';
}

/**
 * Computes the hunks that turn `base` into `side` (Myers diff via jsdiff).
 * Common prefix/suffix are trimmed first, which makes the typical "few changes in a large file" case cheap.
 * If the diff takes too long, the differing middle is reported as a single hunk.
 */
export function diffHunks<T>(base: readonly T[], side: readonly T[]): Hunk[] {
    let prefix = 0;
    const maxPrefix = Math.min(base.length, side.length);
    while (prefix < maxPrefix && base[prefix] === side[prefix]) {
        prefix++;
    }
    let suffix = 0;
    const maxSuffix = maxPrefix - prefix;
    while (suffix < maxSuffix && base[base.length - 1 - suffix] === side[side.length - 1 - suffix]) {
        suffix++;
    }
    const baseMid = base.slice(prefix, base.length - suffix);
    const sideMid = side.slice(prefix, side.length - suffix);
    if (baseMid.length === 0 && sideMid.length === 0) {
        return [];
    }
    if (baseMid.length === 0 || sideMid.length === 0) {
        return [{ baseStart: prefix, baseEnd: prefix + baseMid.length, sideStart: prefix, sideEnd: prefix + sideMid.length }];
    }

    const changes = diffArrays(baseMid as T[], sideMid as T[], { timeout: DIFF_TIMEOUT_MS });
    if (!changes) {
        return [{ baseStart: prefix, baseEnd: prefix + baseMid.length, sideStart: prefix, sideEnd: prefix + sideMid.length }];
    }

    const hunks: Hunk[] = [];
    let b = prefix;
    let s = prefix;
    let current: Hunk | undefined;
    for (const change of changes) {
        const count = change.count ?? change.value.length;
        if (!change.added && !change.removed) {
            if (current) {
                hunks.push(current);
                current = undefined;
            }
            b += count;
            s += count;
            continue;
        }
        current ??= { baseStart: b, baseEnd: b, sideStart: s, sideEnd: s };
        if (change.removed) {
            b += count;
            current.baseEnd = b;
        } else {
            s += count;
            current.sideEnd = s;
        }
    }
    if (current) {
        hunks.push(current);
    }
    return hunks;
}

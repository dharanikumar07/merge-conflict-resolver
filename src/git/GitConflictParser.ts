import { splitLines } from '../merge/DiffEngine';

/** A conflict found via Git's textual markers in a working-tree file. */
export interface MergeConflict {
    id: string;
    /** Line of `<<<<<<<` (0-based). */
    startLine: number;
    /** Line after `>>>>>>>` (exclusive). */
    endLine: number;
    base: string | undefined;
    ours: string;
    theirs: string;
    oursLabel: string;
    theirsLabel: string;
    resolved: boolean;
}

export interface ParsedConflictFile {
    conflicts: MergeConflict[];
    /** The file as it would look if every conflict took the given side. */
    ours: string;
    theirs: string;
    /** Base reconstructed from diff3-style markers; conflict regions are empty when no base section exists. */
    base: string;
}

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SEPARATOR = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

function stripEol(line: string): string {
    return line.replace(/\r?\n$/, '');
}

/** Returns the 0-based line of the first conflict marker, or -1. */
export function findConflictMarkerLine(text: string): number {
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
        const line = stripEol(lines[i]);
        if (START.test(line) || END.test(line)) {
            return i;
        }
    }
    return -1;
}

/**
 * Parses `<<<<<<< / ||||||| / ======= / >>>>>>>` blocks (both merge and diff3 conflict styles).
 * Malformed blocks (missing separator or end marker) are left in place as ordinary text.
 */
export function parseConflictMarkers(text: string): ParsedConflictFile {
    const lines = splitLines(text);
    const conflicts: MergeConflict[] = [];
    let ours = '';
    let theirs = '';
    let base = '';

    let i = 0;
    while (i < lines.length) {
        const start = START.exec(stripEol(lines[i]));
        const block = start ? readBlock(lines, i) : undefined;
        if (!start || !block) {
            ours += lines[i];
            theirs += lines[i];
            base += lines[i];
            i++;
            continue;
        }
        conflicts.push({
            id: `conflict-${conflicts.length + 1}`,
            startLine: i,
            endLine: block.end,
            base: block.base,
            ours: block.ours,
            theirs: block.theirs,
            oursLabel: start[1] ?? '',
            theirsLabel: block.theirsLabel,
            resolved: false,
        });
        ours += block.ours;
        theirs += block.theirs;
        base += block.base ?? '';
        i = block.end;
    }
    return { conflicts, ours, theirs, base };
}

function readBlock(lines: string[], startIndex: number) {
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    const parts = { ours: '', base: undefined as string | undefined, theirs: '' };
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = stripEol(lines[i]);
        if (section === 'ours' && BASE.test(line)) {
            section = 'base';
            parts.base = '';
        } else if (section !== 'theirs' && SEPARATOR.test(line)) {
            section = 'theirs';
        } else if (section === 'theirs' && END.test(line)) {
            return { ...parts, end: i + 1, theirsLabel: END.exec(line)?.[1] ?? '' };
        } else if (section === 'base') {
            parts.base += lines[i];
        } else {
            parts[section] += lines[i];
        }
    }
    return undefined;
}

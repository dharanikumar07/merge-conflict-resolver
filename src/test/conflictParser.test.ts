import * as assert from 'assert/strict';
import { test } from 'node:test';
import { findConflictMarkerLine, parseConflictMarkers } from '../git/GitConflictParser';
import { lines } from './helpers';

test('parses merge-style conflict markers', () => {
    const text = lines('top', '<<<<<<< HEAD', 'current branch code', '=======', 'incoming branch code', '>>>>>>> feature', 'bottom');
    const parsed = parseConflictMarkers(text);
    assert.equal(parsed.conflicts.length, 1);
    const [c] = parsed.conflicts;
    assert.equal(c.startLine, 1);
    assert.equal(c.endLine, 6);
    assert.equal(c.ours, 'current branch code\n');
    assert.equal(c.theirs, 'incoming branch code\n');
    assert.equal(c.base, undefined);
    assert.equal(c.oursLabel, 'HEAD');
    assert.equal(c.theirsLabel, 'feature');
    assert.equal(parsed.ours, lines('top', 'current branch code', 'bottom'));
    assert.equal(parsed.theirs, lines('top', 'incoming branch code', 'bottom'));
    assert.equal(parsed.base, lines('top', 'bottom'));
});

test('parses diff3-style markers, multiple conflicts and CRLF', () => {
    const text = [
        '<<<<<<< ours', 'o1', '||||||| base', 'b1', '=======', 't1', '>>>>>>> theirs',
        'mid',
        '<<<<<<< ours', '=======', 't2', '>>>>>>> theirs',
    ].map(l => l + '\r\n').join('');
    const parsed = parseConflictMarkers(text);
    assert.equal(parsed.conflicts.length, 2);
    assert.equal(parsed.conflicts[0].base, 'b1\r\n');
    assert.equal(parsed.conflicts[1].ours, '');
    assert.equal(parsed.base, 'b1\r\nmid\r\n');
});

test('ignores malformed markers and reports marker lines', () => {
    const text = lines('<<<<<<< HEAD', 'no end', '=======');
    assert.equal(parseConflictMarkers(text).conflicts.length, 0);
    assert.equal(findConflictMarkerLine(lines('ok', '>>>>>>> x')), 1);
    assert.equal(findConflictMarkerLine(lines('ok', '<<<<<<<< eight')), -1);
});

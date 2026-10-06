import * as assert from 'assert/strict';
import { test } from 'node:test';
import { MergeModel } from '../merge/MergeModel';
import { resolveSimpleConflict } from '../merge/MergeEngine';
import { FakeResultDocument, lines } from './helpers';

const BASE = lines('a', 'b', 'c', 'd', 'e', 'f', 'g');

function setup(base: string, ours: string, theirs: string, eol: '\n' | '\r\n' = '\n') {
    const model = MergeModel.create(base, ours, theirs, eol);
    return { model, doc: new FakeResultDocument(model) };
}

test('one simple conflict', () => {
    const { model, doc } = setup(BASE, BASE.replace('c\n', 'c-ours\n'), BASE.replace('c\n', 'c-theirs\n'));
    assert.equal(model.chunks.length, 1);
    const [c] = model.chunks;
    assert.equal(c.kind, 'conflict');
    assert.equal(c.baseText, 'c\n');
    assert.equal(c.oursText, 'c-ours\n');
    assert.equal(c.theirsText, 'c-theirs\n');
    assert.equal(doc.text, BASE, 'result starts as base');
    assert.deepEqual(model.stats(), { conflicts: 1, unresolvedConflicts: 1, pendingChanges: 0, changes: 1 });
});

test('multiple conflicts', () => {
    const ours = lines('a1', 'b', 'c', 'd', 'e', 'f', 'g1');
    const theirs = lines('a2', 'b', 'c', 'd', 'e', 'f', 'g2');
    const { model } = setup(BASE, ours, theirs);
    assert.deepEqual(model.chunks.map(c => c.kind), ['conflict', 'conflict']);
    assert.equal(model.stats().unresolvedConflicts, 2);
});

test('no conflicts', () => {
    const { model, doc } = setup(BASE, BASE, BASE);
    assert.equal(model.chunks.length, 0);
    assert.equal(doc.text, BASE);
});

test('non-conflicting changes: apply all, from yours, from theirs', () => {
    const ours = lines('a', 'B', 'c', 'd', 'e', 'f', 'g');
    const theirs = lines('a', 'b', 'c', 'd', 'e', 'F', 'g', 'h');
    {
        const { model, doc } = setup(BASE, ours, theirs);
        assert.deepEqual(model.chunks.map(c => c.kind), ['ours', 'theirs', 'theirs']);
        assert.equal(model.stats().pendingChanges, 3);
        doc.apply(model.applyNonConflicting('all'));
        assert.equal(doc.text, lines('a', 'B', 'c', 'd', 'e', 'F', 'g', 'h'));
        assert.equal(model.stats().pendingChanges, 0);
    }
    {
        const { model, doc } = setup(BASE, ours, theirs);
        doc.apply(model.applyNonConflicting('ours'));
        assert.equal(doc.text, ours);
        doc.apply(model.applyNonConflicting('theirs'));
        assert.equal(doc.text, lines('a', 'B', 'c', 'd', 'e', 'F', 'g', 'h'));
    }
});

test('apply non-conflicting leaves conflicts alone; identical changes on both sides are non-conflicting', () => {
    const ours = lines('A', 'b', 'c-ours', 'd', 'e', 'f', 'g');
    const theirs = lines('A', 'b', 'c-theirs', 'd', 'e', 'f', 'g');
    const { model, doc } = setup(BASE, ours, theirs);
    assert.deepEqual(model.chunks.map(c => c.kind), ['both', 'conflict']);
    doc.apply(model.applyNonConflicting('all'));
    assert.equal(doc.text, lines('A', 'b', 'c', 'd', 'e', 'f', 'g'));
    assert.equal(model.stats().unresolvedConflicts, 1);
});

test('accept yours / accept theirs on separate conflicts', () => {
    const ours = lines('a1', 'b', 'c', 'd', 'e', 'f', 'g1');
    const theirs = lines('a2', 'b', 'c', 'd', 'e', 'f', 'g2');
    const { model, doc } = setup(BASE, ours, theirs);
    const [first, second] = model.chunks;
    doc.apply(model.accept(second, 'theirs'));
    doc.apply(model.accept(first, 'ours'));
    assert.equal(doc.text, lines('a1', 'b', 'c', 'd', 'e', 'f', 'g2'));
    // The other side's change stays pending until it is ignored (✕) or appended.
    assert.equal(first.theirsState, 'pending');
    assert.equal(second.oursState, 'pending');
    assert.equal(model.stats().unresolvedConflicts, 2);
    model.ignore(first, 'theirs', doc.text.slice(first.start, first.end));
    model.ignore(second, 'ours', doc.text.slice(second.start, second.end));
    assert.ok(first.resolved && second.resolved);
    assert.equal(doc.text, lines('a1', 'b', 'c', 'd', 'e', 'f', 'g2'), 'ignoring keeps the accepted text');
    assert.equal(model.stats().unresolvedConflicts, 0);
});

test('accepting the second side of a conflict appends it after the first', () => {
    const ours = BASE.replace('c\n', 'c-ours\n');
    const theirs = BASE.replace('c\n', 'c-theirs\n');
    {
        const { model, doc } = setup(BASE, ours, theirs);
        const c = model.chunks[0];
        doc.apply(model.accept(c, 'theirs'));
        assert.equal(c.resolved, false);
        doc.apply(model.accept(c, 'ours'));
        assert.equal(doc.text, BASE.replace('c\n', 'c-theirs\nc-ours\n'));
        assert.equal(c.resolved, true);
        assert.equal(model.accept(c, 'ours'), undefined, 'an applied side cannot be applied twice');
    }
    {
        const { model, doc } = setup('a\nb', 'a\nb-ours', 'a\nb-theirs');
        const c = model.chunks[0];
        doc.apply(model.accept(c, 'ours'));
        doc.apply(model.accept(c, 'theirs'));
        assert.equal(doc.text, 'a\nb-ours\nb-theirs', 'a line break is inserted between texts without one');
    }
});

test('accept both, and ignore then accept the other side', () => {
    const ours = BASE.replace('c\n', 'c-ours\n');
    const theirs = BASE.replace('c\n', 'c-theirs\n');
    {
        const { model, doc } = setup(BASE, ours, theirs);
        doc.apply(model.acceptBoth(model.chunks[0]));
        assert.equal(doc.text, BASE.replace('c\n', 'c-ours\nc-theirs\n'));
    }
    {
        const { model, doc } = setup(BASE, ours, theirs);
        const c = model.chunks[0];
        model.ignore(c, 'ours', doc.text.slice(c.start, c.end));
        assert.equal(c.resolved, false, 'theirs still pending');
        model.ignore(c, 'theirs', doc.text.slice(c.start, c.end));
        assert.equal(c.resolved, true);
        assert.equal(doc.text, BASE, 'ignoring both keeps base');
    }
});

test('ignore only affects its own chunk', () => {
    const ours = lines('a1', 'b', 'c', 'd', 'e', 'f', 'g1');
    const theirs = lines('a2', 'b', 'c', 'd', 'e', 'f', 'g2');
    const { model, doc } = setup(BASE, ours, theirs);
    doc.apply(model.accept(model.chunks[1], 'ours'));
    model.ignore(model.chunks[0], 'ours', 'a\n');
    assert.equal(model.chunks[1].oursState, 'applied');
    assert.equal(doc.text, lines('a', 'b', 'c', 'd', 'e', 'f', 'g1'));
});

test('manual editing inside a conflict resolves it; edits elsewhere shift regions', () => {
    const ours = lines('a1', 'b', 'c', 'd', 'e', 'f', 'g1');
    const theirs = lines('a2', 'b', 'c', 'd', 'e', 'f', 'g2');
    const { model, doc } = setup(BASE, ours, theirs);
    doc.type('d\n', 'd\ninserted\nlines\n'); // outside any chunk
    assert.equal(model.stats().unresolvedConflicts, 2);
    assert.equal(doc.text.slice(model.chunks[1].start, model.chunks[1].end), 'g\n', 'second region shifted');

    doc.type('g\n', 'g-manual\n');
    assert.equal(model.chunks[1].edited, true);
    assert.equal(model.chunks[1].resolved, true);
    assert.equal(model.chunks[0].resolved, false);

    // Accept still works on the right region after manual edits.
    doc.apply(model.accept(model.chunks[0], 'theirs'));
    assert.equal(doc.text, lines('a2', 'b', 'c', 'd', 'inserted', 'lines', 'e', 'f', 'g-manual'));
});

test('undo of an accept restores the unresolved state, redo-equivalent restores it again', () => {
    const { model, doc } = setup(BASE, BASE.replace('c\n', 'c-ours\n'), BASE.replace('c\n', 'c-theirs\n'));
    const c = model.chunks[0];
    doc.apply(model.accept(c, 'ours'));
    assert.equal(c.oursState, 'applied');
    doc.undo();
    assert.equal(doc.text, BASE);
    assert.equal(c.resolved, false);
    assert.equal(c.oursState, 'pending');
    doc.type('c\n', 'c-ours\n'); // same text as the accepted state
    assert.equal(c.oursState, 'applied');
});

test('revert resolution', () => {
    const { model, doc } = setup(BASE, BASE.replace('c\n', 'c-ours\n'), BASE.replace('c\n', 'c-theirs\n'));
    const c = model.chunks[0];
    doc.apply(model.accept(c, 'theirs'));
    doc.type('c-theirs\n', 'c-theirs edited\n');
    doc.apply(model.revert(c));
    assert.equal(doc.text, BASE);
    assert.equal(c.resolved, false);
    assert.equal(c.edited, false);
    // The original ours/theirs content is still available for a new decision.
    doc.apply(model.accept(c, 'ours'));
    assert.equal(doc.text, BASE.replace('c\n', 'c-ours\n'));
});

test('resolve simple conflict combines changes to different parts of a line', () => {
    assert.equal(resolveSimpleConflict('hello world\n', 'hello beautiful world\n', 'hello world!\n'), 'hello beautiful world!\n');
    assert.equal(resolveSimpleConflict('x = 1;\n', 'x = 2;\n', 'x = 3;\n'), undefined, 'overlapping change is unsafe');

    const { model, doc } = setup(lines('start', 'hello world', 'end'), lines('start', 'hello beautiful world', 'end'), lines('start', 'hello world!', 'end'));
    const c = model.chunks[0];
    assert.equal(c.kind, 'conflict');
    doc.apply(model.resolveSimple(c));
    assert.equal(doc.text, lines('start', 'hello beautiful world!', 'end'));
    assert.equal(c.resolved, true);
});

test('resolve simple conflict refuses unsafe conflicts', () => {
    const { model, doc } = setup(lines('x = 1;'), lines('x = 2;'), lines('x = 3;'));
    assert.equal(model.resolveSimple(model.chunks[0]), undefined);
    assert.equal(doc.text, lines('x = 1;'));
    assert.equal(model.chunks[0].resolved, false);
});

test('empty files and files added on both sides', () => {
    {
        const { model } = setup('', '', '');
        assert.equal(model.chunks.length, 0);
    }
    {
        const { model, doc } = setup('', lines('ours'), lines('theirs'));
        assert.equal(model.chunks.length, 1);
        assert.equal(model.chunks[0].kind, 'conflict');
        assert.equal(doc.text, '');
        doc.apply(model.accept(model.chunks[0], 'theirs'));
        assert.equal(doc.text, lines('theirs'));
    }
    {
        // Ours emptied the file, theirs untouched → non-conflicting deletion.
        const { model, doc } = setup(BASE, '', BASE);
        assert.equal(model.chunks[0].kind, 'ours');
        doc.apply(model.applyNonConflicting('all'));
        assert.equal(doc.text, '');
    }
});

test('insertion conflicts at the same position and edits next to empty regions', () => {
    const ours = BASE.replace('c\n', 'c\nours-new\n');
    const theirs = BASE.replace('c\n', 'c\ntheirs-new\n');
    const { model, doc } = setup(BASE, ours, theirs);
    const c = model.chunks[0];
    assert.equal(c.kind, 'conflict');
    assert.equal(c.start, c.end, 'empty region in result');
    doc.type('d\n', 'd!\n'); // typing on the line after the empty region does not touch it
    assert.equal(c.resolved, false);
    doc.apply(model.accept(c, 'ours'));
    assert.equal(doc.text, lines('a', 'b', 'c', 'ours-new', 'd!', 'e', 'f', 'g'));
});

test('files without trailing newline', () => {
    const { model, doc } = setup('a\nb', 'a\nb-ours', 'a\nb-theirs');
    doc.apply(model.accept(model.chunks[0], 'ours'));
    assert.equal(doc.text, 'a\nb-ours');
});

test('CRLF content is normalized to the document EOL and merges correctly', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    const ours = lines('a', 'B', 'c', 'd', 'e', 'f', 'g');
    const theirs = lines('a', 'b', 'c', 'd', 'e', 'F', 'g');
    // Mixed inputs (CRLF base, LF sides) must not produce whole-file conflicts.
    const { model, doc } = setup(crlf(BASE), ours, crlf(theirs), '\r\n');
    assert.deepEqual(model.chunks.map(c => c.kind), ['ours', 'theirs']);
    doc.apply(model.applyNonConflicting('all'));
    assert.equal(doc.text, crlf(lines('a', 'B', 'c', 'd', 'e', 'F', 'g')));

    const lf = setup(crlf(BASE), crlf(ours), crlf(theirs), '\n');
    assert.equal(lf.doc.text, BASE);
});

test('UTF-8 and unicode content (CJK, emoji, combining marks, RTL)', () => {
    const combining = 'cafe\u0301';
    const base = lines('名前 = "太郎"', '---', 'emoji = "🙂"', 'café', 'שלום');
    const ours = lines('名前 = "花子"', '---', 'emoji = "🙂"', 'café', 'שלום');
    const theirs = lines('名前 = "太郎"', '---', 'emoji = "🚀🎉"', combining, 'שלום עולם');
    const { model, doc } = setup(base, ours, theirs);
    assert.equal(model.chunks.length, 2);
    doc.apply(model.applyNonConflicting('all'));
    assert.equal(doc.text, lines('名前 = "花子"', '---', 'emoji = "🚀🎉"', combining, 'שלום עולם'));
    assert.equal(resolveSimpleConflict('😀 a b\n', '😀 X b\n', '😀 a Y\n'), '😀 X Y\n');
});

test('large files with scattered changes are handled quickly', () => {
    const n = 50_000;
    const baseLines = Array.from({ length: n }, (_, i) => `line ${i}`);
    const ours = [...baseLines];
    const theirs = [...baseLines];
    for (let i = 100; i < n; i += 1000) {
        ours[i] = `ours ${i}`;
        theirs[i + 500] = `theirs ${i}`;
    }
    ours[n - 1] = 'ours tail';
    theirs[n - 1] = 'theirs tail';
    const join = (a: string[]) => a.map(l => l + '\n').join('');

    const started = Date.now();
    const { model, doc } = setup(join(baseLines), join(ours), join(theirs));
    doc.apply(model.applyNonConflicting('all'));
    const elapsed = Date.now() - started;

    assert.equal(model.stats().conflicts, 1);
    assert.equal(model.stats().pendingChanges, 0);
    assert.ok(model.chunks.length > 90);
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);
});

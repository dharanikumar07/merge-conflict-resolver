import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { classifyConflict, decodeText, GitService } from '../git/GitService';
import { MergeModel } from '../merge/MergeModel';
import { createConflictRepo, FakeResultDocument, git, lines } from './helpers';

const repos: string[] = [];
function repo(files: Parameters<typeof createConflictRepo>[0]): string {
    const dir = createConflictRepo(files);
    repos.push(dir);
    return dir;
}
process.on('exit', () => repos.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

const BASE = lines('one', 'two', 'three', 'four', 'five');

test('integration: retrieves base/ours/theirs for multiple conflicted files and merge labels', async () => {
    const dir = repo({
        'a.txt': { base: BASE, ours: BASE.replace('two', 'two-main'), theirs: BASE.replace('two', 'two-feature') },
        'sub dir/b.txt': { base: BASE, ours: BASE.replace('four', 'FOUR'), theirs: BASE.replace('four', 'four!') },
        'clean.txt': { base: BASE, ours: BASE.replace('one', 'ONE'), theirs: BASE.replace('five', 'FIVE') },
    });
    const { git: service, relativePath } = await GitService.forFile(path.join(dir, 'sub dir', 'b.txt'));
    assert.equal(relativePath, 'sub dir/b.txt');

    const conflicted = (await service.getConflictedFiles()).map(f => f.relativePath).sort();
    assert.deepEqual(conflicted, ['a.txt', 'sub dir/b.txt']);

    const base = decodeText((await service.getBaseVersion('a.txt'))!.content);
    const ours = decodeText((await service.getOursVersion('a.txt'))!.content);
    const theirs = decodeText((await service.getTheirsVersion('a.txt'))!.content);
    assert.equal(base, BASE);
    assert.ok(ours.includes('two-main'));
    assert.ok(theirs.includes('two-feature'));

    const status = await service.getMergeStatus();
    assert.equal(status.operation, 'merge');
    assert.equal(status.oursLabel, 'main');
    assert.equal(status.theirsLabel, 'feature');

    // Resolve through the model and mark resolved; no commit is created.
    const model = MergeModel.create(base, ours, theirs, '\n');
    const doc = new FakeResultDocument(model);
    doc.apply(model.accept(model.chunks[0], 'theirs'));
    fs.writeFileSync(path.join(dir, 'a.txt'), doc.text);
    const headBefore = git(dir, 'rev-parse', 'HEAD');
    await service.markResolved('a.txt');
    assert.deepEqual((await service.getConflictedFiles()).map(f => f.relativePath), ['sub dir/b.txt']);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), headBefore);
});

test('integration: deletion conflicts are classified', async () => {
    const dir = repo({
        'deleted-by-them.txt': { base: BASE, ours: BASE + 'more\n', theirs: null },
        'deleted-by-us.txt': { base: BASE, ours: null, theirs: BASE + 'more\n' },
        'added-both.txt': { ours: 'ours\n', theirs: 'theirs\n' },
    });
    const service = GitService.forRoot(dir);
    const types = Object.fromEntries((await service.getConflictedFiles()).map(f => [f.relativePath, classifyConflict(f.stages)]));
    assert.deepEqual(types, {
        'added-both.txt': 'both-added',
        'deleted-by-them.txt': 'deleted-by-them',
        'deleted-by-us.txt': 'deleted-by-us',
    });
    assert.equal(await service.getTheirsVersion('deleted-by-them.txt'), undefined);
    assert.equal(await service.getBaseVersion('added-both.txt'), undefined);

    await service.removeFile('deleted-by-them.txt');
    assert.equal(fs.existsSync(path.join(dir, 'deleted-by-them.txt')), false);
});

test('integration: binary files are detected', async () => {
    const bin = (s: string) => Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(s)]).toString('latin1');
    const dir = repo({ 'image.bin': { base: bin('base'), ours: bin('ours'), theirs: bin('theirs') } });
    const service = GitService.forRoot(dir);
    assert.equal((await service.getOursVersion('image.bin'))?.binary, true);
    await service.checkoutSide('image.bin', 'theirs');
    assert.equal((await service.getConflictedFiles()).length, 0);
});

test('integration: UTF-8 and CRLF content round-trips', async () => {
    const base = 'héllo\r\nwörld\r\n🙂\r\n';
    const dir = repo({ 'u.txt': { base, ours: base.replace('héllo', 'héllo ours'), theirs: base.replace('wörld', 'wörld theirs') } });
    const service = GitService.forRoot(dir);
    // Non-overlapping edits on adjacent lines still conflict in Git; the model sees them as one conflict that
    // "resolve simple" can combine.
    const model = MergeModel.create(
        decodeText((await service.getBaseVersion('u.txt'))!.content),
        decodeText((await service.getOursVersion('u.txt'))!.content),
        decodeText((await service.getTheirsVersion('u.txt'))!.content),
        '\r\n',
    );
    const doc = new FakeResultDocument(model);
    doc.apply(model.resolveSimple(model.chunks[0]));
    assert.equal(doc.text, 'héllo ours\r\nwörld theirs\r\n🙂\r\n');
});

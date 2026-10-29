import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { buildManifest, createTransfer, mergeJson, resolveRel, rewritePaths, skipPath } from '../src/transfer.js';

async function install(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cf-${name}-`));
  const dirs = Object.fromEntries(['library', 'uploads', 'workspace', 'output'].map((d) => [d, path.join(root, d)]));
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
  return { root, dirs };
}
const put = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

test('transfer: what is copied, path safety, merging', () => {
  assert.ok(skipPath('library/abc/cache/polish.mp4'));
  assert.ok(skipPath('workspace/.session-secret'));
  assert.ok(skipPath('workspace/job1/project/index.html'));
  assert.ok(skipPath('output/job1/video.raw.mp4'));
  assert.ok(!skipPath('library/abc/source.mp4'));
  assert.ok(!skipPath('library/.styles/styles.json'));

  const dirs = { library: '/x/library', uploads: '/x/uploads', workspace: '/x/workspace', output: '/x/output' };
  assert.equal(resolveRel(dirs, 'library/abc/meta.json'), '/x/library/abc/meta.json');
  assert.equal(resolveRel(dirs, 'library/../../etc/passwd'), null);
  assert.equal(resolveRel(dirs, '/etc/passwd'), null);
  assert.equal(resolveRel(dirs, 'tools/x'), null);

  const text = JSON.stringify({ path: '/workspaces/video-editing/library/abc/source.mp4' });
  assert.equal(JSON.parse(rewritePaths(text, { library: '/workspaces/video-editing/library' }, dirs)).path, '/x/library/abc/source.mp4');

  const merged = mergeJson({ folders: [{ id: 'a', name: 'Mine' }], v: 1 }, { folders: [{ id: 'a', name: 'Old' }, { id: 'b', name: 'B' }], v: 2, extra: true });
  assert.deepEqual(merged.folders.map((f) => f.name), ['Mine', 'B']);
  assert.equal(merged.extra, true);
  const auto = mergeJson([{ id: 'new1', name: 'Autopilot' }, { id: 'x', name: 'Mine' }], [{ id: 'old1', name: 'Autopilot' }]);
  assert.deepEqual(auto.map((f) => f.id), ['x', 'old1']);
});

test('transfer: the new install copies everything from the old one with its code', async () => {
  const oldI = await install('old');
  const newI = await install('new');
  const video = Buffer.alloc(300_000, 7);
  await put(path.join(oldI.dirs.library, 'a1', 'source.mp4'), video);
  await put(path.join(oldI.dirs.library, 'a1', 'meta.json'), JSON.stringify({ id: 'a1', name: 'beach.mp4' }));
  await put(path.join(oldI.dirs.library, 'a1', 'cache', 'polish.mp4'), 'cache');
  await put(path.join(oldI.dirs.library, '.folders.json'), JSON.stringify({ folders: [{ id: 'f1', name: 'Summer' }] }));
  await put(path.join(oldI.dirs.uploads, 'job1', 'clips.json'), JSON.stringify({ clips: [{ path: path.join(oldI.dirs.library, 'a1', 'source.mp4') }] }));
  await put(path.join(oldI.dirs.workspace, '.session-secret'), 'secret');
  await put(path.join(newI.dirs.library, '.folders.json'), JSON.stringify({ folders: [{ id: 'f9', name: 'Mine' }] }));

  const oldT = createTransfer({ dirs: oldI.dirs, log: () => {} });
  const app = express();
  app.get('/api/transfer/manifest', (q, r) => oldT.serveManifest(q, r));
  app.get('/api/transfer/file', (q, r) => oldT.serveFile(q, r));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { code } = oldT.makeCode({ headers: {} });
    let done;
    const finished = new Promise((r) => (done = r));
    const newT = createTransfer({ dirs: newI.dirs, onDone: done, log: () => {} });

    await assert.rejects(newT.pull({ url, code: 'nope-nope-nope' }), /Wrong or expired/);
    const started = await newT.pull({ url: `${url}/`, code: code.toUpperCase() });
    assert.equal(started.state, 'running');
    const job = await finished;
    assert.equal(job.failed.length, 0);

    assert.deepEqual(await fs.readFile(path.join(newI.dirs.library, 'a1', 'source.mp4')), video);
    assert.equal(JSON.parse(await fs.readFile(path.join(newI.dirs.library, 'a1', 'meta.json'), 'utf8')).name, 'beach.mp4');
    const clips = JSON.parse(await fs.readFile(path.join(newI.dirs.uploads, 'job1', 'clips.json'), 'utf8'));
    assert.equal(clips.clips[0].path, path.join(newI.dirs.library, 'a1', 'source.mp4'));
    const folders = JSON.parse(await fs.readFile(path.join(newI.dirs.library, '.folders.json'), 'utf8'));
    assert.deepEqual(folders.folders.map((f) => f.name).sort(), ['Mine', 'Summer']);
    await assert.rejects(fs.stat(path.join(newI.dirs.library, 'a1', 'cache', 'polish.mp4')));
    await assert.rejects(fs.stat(path.join(newI.dirs.workspace, '.session-secret')));

    // Again: what's already here is skipped.
    let again;
    const second = new Promise((r) => (again = r));
    const t2 = createTransfer({ dirs: newI.dirs, onDone: again, log: () => {} });
    const j2 = await t2.pull({ url, code });
    assert.ok(j2.skipped >= 3);
    assert.equal(j2.files, 1); // only the merged folders file
    await second;
    assert.equal((await buildManifest(newI.dirs)).length, 4);
  } finally {
    server.close();
    await fs.rm(oldI.root, { recursive: true, force: true });
    await fs.rm(newI.root, { recursive: true, force: true });
  }
});

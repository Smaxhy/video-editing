import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFolders, normalizeFolder, FOLDER_COLORS } from '../src/folders.js';

test('folders are created, renamed, kept sorted, persisted and removed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-folders-'));
  const file = path.join(dir, '.folders.json');
  const f = createFolders({ file });
  await f.load();
  const b = await f.create({ name: '  Summer   reels ' });
  const a = await f.create({ name: 'Client: Oak', color: '#22c55e' });
  assert.equal(b.name, 'Summer reels');
  assert.equal(a.color, '#22c55e');
  assert.deepEqual(f.list().map((x) => x.name), ['Client: Oak', 'Summer reels']);
  await f.update(b.id, { name: 'Autumn reels', color: 'red' }); // unknown colour keeps the old one
  assert.equal(f.get(b.id).name, 'Autumn reels');
  assert.ok(FOLDER_COLORS.includes(f.get(b.id).color));
  assert.equal((await f.ensure('autumn REELS')).id, b.id);
  const again = createFolders({ file });
  await again.load();
  assert.equal(again.list().length, 2);
  assert.equal(await again.remove(a.id), true);
  assert.equal(again.has(a.id), false);
  assert.throws(() => normalizeFolder({ name: '   ' }), /name/);
  await fs.rm(dir, { recursive: true, force: true });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { run, killAllChildren } from '../src/util.js';

const count = (pattern) => Number(execFileSync("bash", ["-c", `pgrep -c -f "^${pattern}$" || true`]).toString().trim());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('cancelling a run kills its whole process tree (grandchildren too)', { skip: process.platform === 'win32' }, async () => {
  const ac = new AbortController();
  const p = run('bash', ['-c', 'sleep 307 & sleep 307 & wait'], { signal: ac.signal });
  await wait(400);
  assert.equal(count('sleep 307'), 2, 'grandchildren started');
  ac.abort();
  await p;
  await wait(400);
  assert.equal(count('sleep 307'), 0, 'grandchildren stopped');
});

test('killAllChildren stops every running tree', { skip: process.platform === 'win32' }, async () => {
  const p = run('bash', ['-c', 'sleep 309 & sleep 309 & wait']);
  await wait(400);
  assert.equal(count('sleep 309'), 2);
  assert.ok(killAllChildren() >= 1);
  await p;
  await wait(400);
  assert.equal(count('sleep 309'), 0);
});

test('gentle background work: capped ffmpeg threads, low priority, one heavy encode at a time', async () => {
  const { gentleArgs, run, setGentle } = await import('../src/util.js');
  assert.deepEqual(gentleArgs(['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'], 2), ['-filter_threads', '2', '-threads', '2', '-i', 'in.mp4', '-c:v', 'libx264', '-threads', '2', 'out.mp4']);
  assert.deepEqual(gentleArgs(['-threads', '1', '-i', 'a', 'b'], 2), ['-threads', '1', '-i', 'a', 'b']);

  setGentle(true);
  // Runs at the lowest priority (niceness 19 on Linux).
  if (process.platform === 'linux') {
    const r = await run('sh', ['-c', 'sleep 0.3; cut -d" " -f19 /proc/self/stat'], { background: true });
    assert.equal(r.stdout.trim(), '19');
  }
  // Two heavy jobs: the second starts only after the first finished.
  const t0 = Date.now();
  const stamps = await Promise.all([1, 2].map(async () => {
    await run('sh', ['-c', 'sleep 0.3'], { background: 'heavy' });
    return Date.now() - t0;
  }));
  assert.ok(Math.max(...stamps) >= 550, `heavy jobs overlapped: ${stamps}`);
  // Off: plain priority, no queue.
  setGentle(false);
  const r2 = await run('sh', ['-c', 'sleep 0.3; cut -d" " -f19 /proc/self/stat'], { background: true });
  if (process.platform === 'linux') assert.equal(r2.stdout.trim(), '0');
  setGentle(true);
});

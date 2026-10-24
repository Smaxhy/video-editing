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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickEvictions, cacheBudget } from '../src/storage.js';

const GB = 1024 ** 3;
const H = 3600_000;

test('cache clean-up removes the least recently used files first, never ones in use', () => {
  const now = 100 * H;
  const files = [
    { path: 'old', size: 3 * GB, mtime: now - 50 * H },
    { path: 'mid', size: 2 * GB, mtime: now - 10 * H },
    { path: 'fresh', size: 2 * GB, mtime: now - 0.2 * H }, // a render may be using it
  ];
  assert.deepEqual(pickEvictions(files, 3 * GB, { now }).map((f) => f.path), ['old', 'mid']);
  assert.deepEqual(pickEvictions(files, 10 * GB, { now }), []);
  assert.deepEqual(pickEvictions(files, 0, { now }).map((f) => f.path), ['old', 'mid']);
});

test('the cache budget scales with the disk and shrinks when it is nearly full', () => {
  assert.equal(cacheBudget({ total: 32 * GB, free: 20 * GB }), 32 * GB * 0.12);
  assert.equal(cacheBudget({ total: 500 * GB, free: 300 * GB }), 6 * GB);
  assert.equal(cacheBudget({ total: 4 * GB, free: 3 * GB }), 0.5 * GB);
  assert.equal(cacheBudget({ total: 32 * GB, free: 2 * GB }), 0.5 * GB);
});

test('which imports get compressed', async () => {
  const { shouldShrink, shouldCompressAudio } = await import('../src/library.js');
  assert.equal(shouldShrink({ width: 3840, height: 2160, duration: 10 }, 50e6), true); // 4K
  assert.equal(shouldShrink({ width: 1920, height: 1080, duration: 10 }, 40e6), true); // 32 Mbps phone video
  assert.equal(shouldShrink({ width: 1920, height: 1080, duration: 10 }, 8e6), false); // already efficient
  assert.equal(shouldCompressAudio('song.wav', 50e6), true);
  assert.equal(shouldCompressAudio('song.mp3', 50e6), false);
  assert.equal(shouldCompressAudio('tiny.wav', 2e6), false);
});

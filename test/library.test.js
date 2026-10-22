import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proxyReason, spriteLayout } from '../src/library.js';

const base = { container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', hasAudio: true, width: 1920, height: 1080, bitRate: 8e6 };

test('proxyReason: browser-friendly files stream as-is', () => {
  assert.equal(proxyReason(base, '.mp4'), null);
  assert.equal(proxyReason({ ...base, hasAudio: false, audioCodec: null }, '.mov'), null);
  assert.equal(proxyReason({ ...base, container: 'matroska,webm', videoCodec: 'vp9', audioCodec: 'opus' }, '.webm'), null);
});

test('proxyReason: containers, codecs and heavy files that need a preview copy', () => {
  assert.match(proxyReason({ ...base, container: 'matroska,webm' }, '.mkv'), /MKV/);
  assert.match(proxyReason({ ...base, videoCodec: 'prores' }, '.mov'), /prores/);
  assert.match(proxyReason({ ...base, pixFmt: 'yuv422p10le' }, '.mp4'), /yuv422p10le/);
  assert.match(proxyReason({ ...base, audioCodec: 'pcm_s24le' }, '.mov'), /pcm_s24le/);
  assert.match(proxyReason({ ...base, width: 3840, height: 2160 }, '.mp4'), /1080p/);
  assert.match(proxyReason({ ...base, bitRate: 80e6 }, '.mp4'), /bitrate/);
});

test('spriteLayout: ~1 frame per second, clamped to 8–60, 10 per row', () => {
  assert.deepEqual(spriteLayout(3), { count: 8, cols: 8, rows: 1, w: 160, h: 90, interval: 3 / 8 });
  const mid = spriteLayout(25.2);
  assert.equal(mid.count, 26);
  assert.equal(mid.cols, 10);
  assert.equal(mid.rows, 3);
  const long = spriteLayout(3600);
  assert.equal(long.count, 60);
  assert.equal(long.interval, 60);
});

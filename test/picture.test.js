import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSignalstats, shakeFromTrf, gradeFilters } from '../src/picture.js';

test('signalstats are averaged over frames', () => {
  const s = parseSignalstats('lavfi.signalstats.YAVG=100\nlavfi.signalstats.YAVG=120\nlavfi.signalstats.UAVG=128\nlavfi.signalstats.VAVG=130\nlavfi.signalstats.SATAVG=50\nlavfi.signalstats.YLOW=30\nlavfi.signalstats.YHIGH=200\n');
  assert.deepEqual(s, { y: 110, u: 128, v: 130, sat: 50, ylow: 30, yhigh: 200 });
  assert.equal(parseSignalstats(''), null);
});

test('shake: a steady camera scores ~0, a jittery one scores high', () => {
  const frames = (fn) => Array.from({ length: 60 }, (_, i) => `Frame ${i + 1} (List 2 [(LM ${fn(i)} 0 10 10 48 0.5 1),(LM ${fn(i)} 0 30 10 48 0.5 1)])`).join('\n');
  assert.equal(shakeFromTrf(frames(() => 0)), 0);
  // A smooth pan is not shake.
  assert.ok(shakeFromTrf(frames(() => 3)) < 0.3);
  assert.ok(shakeFromTrf(frames((i) => (i % 2 ? 30 : -30))) > 1.5);
});

test('grading brightens dark footage, fixes casts and leaves good footage nearly alone', () => {
  const dark = gradeFilters({ y: 62, u: 140, v: 128, sat: 40, ylow: 20, yhigh: 150 }).join(',');
  assert.match(dark, /eq=gamma=1\.\d+/);
  assert.match(dark, /colorbalance=rm=0:bm=-0\.084/);
  assert.match(dark, /hqdn3d/);
  const good = gradeFilters({ y: 118, u: 128, v: 128, sat: 90, ylow: 30, yhigh: 220 });
  assert.deepEqual(good, ['eq=gamma=1:contrast=1:saturation=1.04']);
});

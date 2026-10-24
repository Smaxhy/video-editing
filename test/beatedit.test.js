import { test } from 'node:test';
import assert from 'node:assert/strict';

import { beatEdit, beatPeriod } from '../src/beatedit.js';
import { layoutTimeline } from '../src/renderer.js';

const sc = (clip, start, end, extra = {}) => ({ clip, start, end, transition: 'cut', transitionDuration: 0, speed: 1, volume: 0.3, effect: 'none', note: '', ...extra });
const grid = (bpm, until) => Array.from({ length: Math.ceil((until * bpm) / 60) + 4 }, (_, i) => Math.round(((i * 60) / bpm) * 1000) / 1000);

test('music edit: every cut on a beat, a build into the drop, a slow-motion hit on it', () => {
  const plan = { scenes: [sc('a', 0, 6), sc('b', 2, 9), sc('c', 0, 5, { peak: true }), sc('d', 1, 8), sc('e', 0, 6)], overlays: [], audio: {} };
  const beats = grid(120, 40);
  const { plan: out, shots } = beatEdit(plan, { beats, drop: 8, talking: () => false, clipDuration: () => 30, energy: 'high', total: 20 });
  assert.ok(shots >= 10, `shots ${shots}`);
  const lay = layoutTimeline(out);
  for (const s of lay.scenes.slice(1)) {
    const off = Math.min(...beats.map((b) => Math.abs(b - s.tlStart)));
    assert.ok(off < 0.03, `cut at ${s.tlStart} is off the beat by ${off}`);
  }
  const hero = lay.scenes.find((s) => s.peak);
  assert.ok(hero && Math.abs(hero.tlStart - 8) < 0.03, `hero at ${hero?.tlStart}`);
  assert.equal(hero.speed, 0.5);
  assert.equal(hero.transition, 'flash');
  assert.equal(hero.effect, 'shake');
  assert.equal(hero.clip, 'c');
  const build = lay.scenes.filter((s) => s.tlStart >= 6 && s.tlStart < 8);
  assert.ok(build.length >= 3 && build.every((s) => s.duration <= 0.55), `build ${build.map((s) => s.duration)}`);
  assert.ok(Math.abs(lay.total - 20) <= 1.05, `total ${lay.total}`);
  assert.ok(out.scenes.every((s) => s.end <= 30 && s.end > s.start));
});

test('talking videos and beatless plans are left alone', () => {
  const talky = { scenes: [sc('t', 0, 5), sc('t', 6, 10), sc('b', 0, 3)], overlays: [], audio: {} };
  assert.equal(beatEdit(talky, { beats: grid(120, 20), talking: (s) => s.clip === 't', clipDuration: () => 30 }).shots, 0);
  assert.equal(beatEdit(talky, { beats: [], talking: () => false, clipDuration: () => 30 }).shots, 0);
  assert.ok(Math.abs(beatPeriod(grid(90, 10)) - 0.667) < 0.01);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeBeats, snapCutsToBeats } from '../src/beats.js';
import { sfxCues } from '../src/sfx.js';
import { layoutTimeline } from '../src/renderer.js';

test('beat tracker finds 120 BPM and the accented downbeats of a click track', () => {
  const SR = 22050;
  const samples = new Float32Array(SR * 30);
  for (let i = 0; i < samples.length; i++) {
    const t = i / SR;
    const ph = t % 0.5;
    const accent = t % 2 < 0.5 ? 2.5 : 1;
    samples[i] = accent * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-ph * 25) * 0.4;
  }
  const r = analyzeBeats(samples);
  assert.ok(Math.abs(r.bpm - 120) < 2, `bpm ${r.bpm}`);
  const off = r.beats.map((b) => Math.abs(b - Math.round(b / 0.5) * 0.5));
  assert.ok(Math.max(...off) < 0.05, `max beat error ${Math.max(...off)}`);
  assert.ok(r.downbeats.slice(0, 3).every((d) => Math.abs(d % 2) < 0.06 || Math.abs((d % 2) - 2) < 0.06), JSON.stringify(r.downbeats.slice(0, 3)));
});

test('B-roll cuts snap to the nearest downbeat; talking cuts stay put', () => {
  const sc = (clip, start, end) => ({ clip, start, end, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none' });
  const plan = { scenes: [sc('broll', 0, 1.8), sc('talk', 5, 7.1), sc('broll', 3, 5)], overlays: [{ type: 'text', text: 'x', start: 2, end: 3, position: 'bottom' }], audio: {} };
  const r = snapCutsToBeats(plan, { beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], downbeats: [2, 4] }, {
    talking: (s) => s.clip === 'talk',
    clipDuration: () => 60,
    layout: layoutTimeline,
  });
  assert.equal(r.moved, 1);
  assert.equal(r.plan.scenes[0].end, 2); // 1.8 → downbeat at 2.0
  assert.equal(r.plan.scenes[1].end, 7.1); // talking scene untouched
  assert.equal(r.plan.overlays[0].start, 2.2);
});

test('sound effects: whoosh into transitions, riser before the CTA, never crowded', () => {
  const timeline = { scenes: [{ index: 0, tlStart: 0, transition: 'cut' }, { index: 1, tlStart: 3, transition: 'crossfade' }] };
  const cues = sfxCues({
    timeline,
    overlays: [{ type: 'hook', start: 0 }, { type: 'text', start: 2.85 }, { type: 'cta', start: 8 }],
    emojiTimes: [0.1, 5],
  });
  assert.deepEqual(cues.map((c) => c.name), ['pop', 'whoosh', 'pop', 'riser', 'pop']);
  assert.equal(cues.find((c) => c.name === 'riser').start, 6.55);
});

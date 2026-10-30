import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { spicePlan } from '../src/spice.js';
import { rampSlowMo, smoothSlowMo, sourceFps } from '../src/slowmo.js';
import { musicPrompt, loopFilter } from '../src/musicgen.js';
import { layoutTimeline, buildComposition } from '../src/renderer.js';
import { sfxCues } from '../src/sfx.js';
import { normalizePlan, normalizeSound, buildPrompt, INTENSITY_GUIDE } from '../src/editor.js';

const HAS_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const sc = (clip, start, end, extra = {}) => ({ clip, start, end, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none', ...extra });
const opts = (extra = {}) => ({
  talking: (s) => s.clip === 'talk',
  clipDuration: () => 100,
  layout: layoutTimeline,
  ...extra,
});

test('creator intensity styles beat-landing B-roll cuts and keeps them on the beat', () => {
  const plan = { scenes: [sc('a', 0, 2), sc('b', 0, 2), sc('c', 0, 2), sc('d', 0, 2), sc('e', 0, 2, { peak: true }), sc('f', 0, 2)], overlays: [], audio: {} };
  const before = layoutTimeline(plan).scenes.map((s) => s.tlStart);
  const { plan: out, added } = spicePlan(plan, opts({ intensity: 'creator', energy: 'high', downbeats: [2, 4, 6, 8, 10] }));
  assert.ok(added >= 2, `added ${added}`);
  const after = layoutTimeline(out).scenes.map((s) => s.tlStart);
  after.forEach((t, i) => assert.ok(Math.abs(t - before[i]) < 0.011, `scene ${i} moved ${before[i]} → ${t}`));
  assert.equal(out.scenes[4].transition, 'flash');
  assert.equal(out.scenes[4].effect, 'shake');
  assert.ok(out.scenes.slice(1).some((s) => s.transition !== 'cut' && s.transition !== 'flash'));
});

test('clean intensity leaves the plan alone; talking cuts only ever get a punch', () => {
  const plan = { scenes: [sc('a', 0, 3), sc('talk', 0, 6), sc('talk', 10, 16), sc('b', 0, 3)], overlays: [], audio: {} };
  assert.equal(spicePlan(plan, opts({ intensity: 'clean' })).plan, plan);
  const { plan: out } = spicePlan(plan, opts({ intensity: 'max', energy: 'high' }));
  for (const [i, s] of out.scenes.entries()) {
    if (i > 0 && (s.clip === 'talk' || out.scenes[i - 1].clip === 'talk')) assert.ok(['cut', 'punch'].includes(s.transition), s.transition);
  }
});

test('slow-motion ramp keeps the scene length and every later cut', () => {
  const plan = { scenes: [sc('a', 0, 2), sc('b', 5, 7, { speed: 0.5, peak: true }), sc('c', 0, 2)], overlays: [], audio: {} };
  const before = layoutTimeline(plan);
  const { plan: out, ramps } = rampSlowMo(plan, { talking: () => false, clipDuration: () => 100 });
  assert.equal(ramps, 1);
  assert.deepEqual(out.scenes.slice(1, 4).map((s) => s.speed), [0.85, 0.65, 0.5]);
  assert.equal(out.scenes[1].peak, true);
  assert.ok(Math.abs(layoutTimeline(out).total - before.total) < 0.01, `${layoutTimeline(out).total} vs ${before.total}`);
  assert.ok(out.scenes.slice(2, 4).every((s) => s.ramp));
});

test('AI music prompt and seamless loop graph', () => {
  assert.equal(musicPrompt({ prompt: 'warm lo-fi beat' }), 'warm lo-fi beat, instrumental, no vocals, high quality');
  assert.match(musicPrompt({ style: 'dark trap', vibe: 'hype', bpm: 140 }), /dark trap, hype mood, 140 bpm/);
  assert.equal(loopFilter(1, 2), '[0:a]anull[out]');
  assert.equal(loopFilter(3, 2), '[0:a][1:a]acrossfade=d=2:c1=tri:c2=tri[x1];[x1][2:a]acrossfade=d=2:c1=tri:c2=tri[out]');
  assert.equal(normalizeSound({ style: 'lofi', prompt: 'soft piano, 80 bpm' }).prompt, 'soft piano, 80 bpm');
});

test('new transitions validate, render as tweens and get matching sound effects', () => {
  const clips = [{ id: 'a', name: 'a.mp4', duration: 30, width: 1080, height: 1920, hasAudio: false, file: 'a.mp4' }];
  const { plan } = normalizePlan({
    scenes: [
      sc('a', 0, 2), sc('a', 3, 5, { transition: 'whip', transitionDuration: 0.25 }), sc('a', 6, 8, { transition: 'flash' }),
      sc('a', 9, 11, { transition: 'glitch' }), sc('a', 12, 14, { transition: 'zoom-through', transitionDuration: 0.3 }),
      sc('a', 15, 17, { transition: 'light-leak', transitionDuration: 0.6 }), sc('a', 18, 20, { transition: 'punch', effect: 'shake' }),
      sc('a', 21, 23, { transition: 'spin', transitionDuration: 0.3 }),
    ],
  }, clips);
  assert.deepEqual(plan.scenes.map((s) => s.transition), ['cut', 'whip', 'flash', 'glitch', 'zoom-through', 'light-leak', 'punch', 'spin']);
  const { html } = buildComposition({ plan: { ...plan, title: 't', overlays: [] }, clips, transcripts: {}, settings: { width: 1080, height: 1920, captions: 'off', motion: 'punchy' } });
  for (const needle of ['#mb0g', '#mb1g', 'id="flash"', 'id="glitch"', 'id="lk0"', 'expo.out', 'rotation: 28', 'filter: url(#mb1)']) assert.ok(html.includes(needle), needle);
  const cues = sfxCues({ timeline: layoutTimeline(plan), overlays: [], level: 'full' }).map((c) => c.name);
  for (const name of ['whoosh', 'hit', 'glitch']) assert.ok(cues.includes(name), `${name} in ${cues}`);
  // Subtle (the default): no glitch noises, and never two sounds within 2.5 s.
  const subtle = sfxCues({ timeline: layoutTimeline(plan), overlays: [], level: 'subtle' });
  assert.ok(!subtle.some((c) => c.name === 'glitch'));
  assert.ok(subtle.every((c, i) => i === 0 || c.start - subtle[i - 1].start >= 2.5), JSON.stringify(subtle));
  assert.ok(subtle.length >= 3 && subtle.length < cues.length);
});

test('the planner gets the intensity guide', () => {
  const clips = [{ id: 'clip1', name: 'a.mp4', duration: 30, width: 1080, height: 1920, hasAudio: true }];
  const base = { goal: 'social', versions: ['30'], formats: [{ label: 'Vertical', width: 1080, height: 1920 }], captions: 'bold' };
  assert.ok(buildPrompt({ clips, userPrompt: 'x', options: { ...base, intensity: 'max' } }).includes(INTENSITY_GUIDE.max));
  const p = buildPrompt({ clips, userPrompt: 'x', options: { ...base, aiMusic: true } });
  assert.ok(p.includes(INTENSITY_GUIDE.creator));
  assert.match(p, /composes the background music/);
});

test('slow motion is interpolated to a smooth frame rate', { skip: !HAS_FFMPEG }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-slowmo-'));
  const src = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  const out = await smoothSlowMo(src, path.join(dir, 'slow.mp4'), { start: 1, end: 2, speed: 0.5 });
  assert.ok(out);
  assert.ok(Math.abs((await sourceFps(out)) - 60) < 1);
  assert.equal(await smoothSlowMo(out, path.join(dir, 'again.mp4'), { start: 0, end: 1, speed: 0.5 }), null); // already 60 fps
  await fs.rm(dir, { recursive: true, force: true });
});

test('tiny slow-motion steps are not interpolated (they could come out with no video)', { skip: !HAS_FFMPEG }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-slowmo2-'));
  const src = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  assert.equal(await smoothSlowMo(src, path.join(dir, 'tiny.mp4'), { start: 1, end: 1.15, speed: 0.65 }), null);
  await fs.rm(dir, { recursive: true, force: true });
});

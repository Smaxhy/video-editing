import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, normalizeResponse, normalizePlan, planLength } from '../src/editor.js';
import { layoutTimeline, buildCaptions, buildComposition, aspectMismatch } from '../src/renderer.js';

const clips = [
  { id: 'clip1', name: 'a.mp4', file: 'clip1.mp4', duration: 20, width: 1920, height: 1080, hasAudio: true },
  { id: 'clip2', name: 'b.mp4', file: 'clip2.mp4', duration: 10, width: 1080, height: 1920, hasAudio: false },
];
const options = { versions: ['15', 'full'], formats: [], goal: 'social', captions: 'bold' };

const scene = (clip, start, end, extra = {}) => ({ clip, start, end, ...extra });

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('here you go {"a": {"b": 2}} done'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'));
});

test('normalizePlan clamps times, drops bad scenes and fixes the opening transition', () => {
  const { plan, warnings } = normalizePlan(
    {
      scenes: [
        scene('clip1', -2, 5, { transition: 'crossfade' }),
        scene('nope', 0, 3),
        scene('clip2', 4, 99, { speed: 10, transition: 'teleport' }),
        scene('clip1', 6, 6.05),
      ],
      overlays: [{ type: 'hook', text: 'Watch this', start: 0, end: 2 }, { text: '' }],
    },
    clips,
  );
  assert.equal(plan.scenes.length, 2);
  assert.deepEqual([plan.scenes[0].start, plan.scenes[0].end], [0, 5]);
  assert.equal(plan.scenes[0].transition, 'fadeblack'); // nothing to crossfade from
  assert.equal(plan.scenes[1].end, 10);
  assert.equal(plan.scenes[1].speed, 4);
  assert.equal(plan.scenes[1].transition, 'cut');
  assert.equal(plan.overlays.length, 1);
  assert.equal(plan.overlays[0].position, 'top');
  assert.ok(warnings.length >= 3);
});

test('normalizeResponse requires every requested version', () => {
  const v = (id) => ({ id, scenes: [scene('clip1', 0, 5)] });
  const ok = normalizeResponse({ title: 'T', versions: [v('15s'), v('full')], checklist: [{ request: 'x', done: 'y' }] }, clips, options);
  assert.deepEqual(ok.versions.map((x) => x.id), ['15', 'full']);
  assert.equal(ok.checklist.length, 1);
  assert.throws(() => normalizeResponse({ versions: [v('15')] }, clips, options), /full/);
});

test('normalizeResponse warns when a version blows its length budget', () => {
  const res = normalizeResponse({ versions: [{ id: '15', scenes: [scene('clip1', 0, 20)] }] }, clips, { ...options, versions: ['15'] });
  assert.match(res.warnings.join(' '), /15s version came out 20\.0s/);
});

test('layoutTimeline overlaps crossfades and accounts for speed', () => {
  const plan = {
    scenes: [
      { ...scene('clip1', 0, 4), transition: 'cut', transitionDuration: 0, speed: 1 },
      { ...scene('clip1', 10, 14), transition: 'crossfade', transitionDuration: 1, speed: 2 },
    ],
  };
  const { scenes, total } = layoutTimeline(plan);
  assert.equal(scenes[1].duration, 2);
  assert.equal(scenes[1].overlapIn, 1);
  assert.equal(scenes[1].tlStart, 3);
  assert.equal(scenes[0].overlapOut, 1);
  assert.equal(total, 5);
  assert.equal(planLength(plan), 5);
});

test('buildCaptions maps source words to timeline time and never overlaps', () => {
  const timeline = layoutTimeline({
    scenes: [
      { ...scene('clip1', 2, 4), transition: 'cut', transitionDuration: 0, speed: 1 },
      { ...scene('clip1', 10, 12), transition: 'cut', transitionDuration: 0, speed: 1 },
    ],
  });
  const words = [
    { word: 'skipped', start: 0.5, end: 1 },
    { word: 'Hello', start: 2.1, end: 2.5 },
    { word: 'there.', start: 2.6, end: 3 },
    { word: 'Later', start: 10.2, end: 10.6 },
  ];
  const cues = buildCaptions(timeline, { clip1: { words } }, 'clean');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello there.');
  assert.equal(cues[0].start, 0.1);
  assert.equal(cues[1].start, 2.2);
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i - 1].end <= cues[i].start);
  assert.equal(buildCaptions(timeline, { clip1: { words } }, 'off').length, 0);
});

test('buildComposition emits a valid HyperFrames root, blur fill and CTA', () => {
  const plan = {
    title: 'Test <&>',
    scenes: [{ ...scene('clip1', 0, 5), transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'punch-in' }],
    overlays: [
      { type: 'hook', text: 'Hook "quoted"', subtext: '', start: 0, end: 2, position: 'top' },
      { type: 'cta', text: 'Buy now', subtext: 'Brand', start: 3, end: 5, position: 'center' },
    ],
    audio: { fadeIn: 0, fadeOut: 0.5 },
  };
  const words = [{ word: 'before', start: 1, end: 1.4 }, { word: 'during', start: 3.5, end: 3.9 }];
  const { html, total, captions } = buildComposition({
    plan,
    clips: [{ ...clips[0], blurFile: 'clip1-blur.mp4' }],
    transcripts: { clip1: { words } },
    settings: { width: 1080, height: 1920, captions: 'bold', framing: 'blur', accent: '#ff0000' },
  });
  assert.equal(total, 5);
  assert.match(html, /data-composition-id="main"[^>]*data-width="1080" data-height="1920" data-duration="5"/);
  assert.match(html, /window\.__timelines\["main"\] = tl/);
  assert.match(html, /<video id="b0" class="bg" src="media\/clip1-blur\.mp4"/);
  assert.match(html, /object-fit: contain/);
  assert.match(html, /data-automation='\{"version":1/);
  assert.match(html, /Hook &quot;quoted&quot;/);
  assert.match(html, /<title>Test &lt;&amp;&gt;<\/title>/);
  assert.match(html, /class="btn">Buy now</);
  assert.deepEqual(captions.map((c) => c.text), ['BEFORE']); // caption under the CTA was dropped
});

test('aspectMismatch', () => {
  assert.equal(aspectMismatch({ width: 1920, height: 1080 }, 1920, 1080), false);
  assert.equal(aspectMismatch({ width: 1920, height: 1080 }, 1080, 1920), true);
  assert.equal(aspectMismatch({ width: 1080, height: 1350 }, 1080, 1350), false);
});

import { faceCenter, coverPositionFor } from '../src/renderer.js';

test('faceCenter takes the median face inside a source range', () => {
  const faces = [{ t: 0, x: 0.2, y: 0.4 }, { t: 1, x: 0.3, y: 0.5 }, { t: 2, x: 0.9, y: 0.5 }, { t: 9, x: 0.1, y: 0.1 }];
  assert.deepEqual(faceCenter(faces, 0, 2), { x: 0.3, y: 0.5 });
  assert.equal(faceCenter(faces, 4, 6), null);
});

test('coverPositionFor keeps the face centred and clamps at the frame edges', () => {
  const clip = { width: 1920, height: 1080 };
  // 16:9 → 9:16: scaled width 3413px, visible 1080px.
  const mid = coverPositionFor({ x: 0.5, y: 0.5 }, clip, 1080, 1920);
  assert.equal(mid.position, '50% 50%');
  const left = coverPositionFor({ x: 0.3, y: 0.5 }, clip, 1080, 1920);
  const [px] = left.position.split(' ').map(parseFloat);
  // Face at 30% of 3413px = 1024px; window starts at 1024-540 = 484 of 2333 travel → ~20.7%.
  assert.ok(Math.abs(px - 20.75) < 0.1, left.position);
  assert.equal(left.origin, '50% 50%');
  const edge = coverPositionFor({ x: 0.02, y: 0.5 }, clip, 1080, 1920);
  assert.ok(edge.position.startsWith('0% '));
  assert.ok(parseFloat(edge.origin) < 50); // face sits left of centre when clamped
});

test('buildComposition: face crop, isolated voice track and watermark', () => {
  const plan = {
    title: 'T',
    scenes: [{ clip: 'clip1', start: 0, end: 4, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'punch-in' }],
    overlays: [],
    audio: { fadeIn: 0, fadeOut: 0 },
  };
  const { html } = buildComposition({
    plan,
    clips: [{ ...clips[0], voiceFile: 'clip1-voice.m4a', faces: [{ t: 1, x: 0.3, y: 0.4 }] }],
    transcripts: {},
    settings: { width: 1080, height: 1920, captions: 'off', framing: 'face', logoFile: 'logo.png', watermark: true },
  });
  assert.match(html, /<video id="v0"[^>]* muted style="object-fit: cover; object-position: 20\.\d+% /);
  assert.match(html, /<audio id="a0" src="media\/clip1-voice\.m4a" data-start="0" data-duration="4" data-media-start="0"[^>]*data-volume="1"/);
  assert.match(html, /<div id="wm" class="clip wm" data-start="0" data-duration="4"[^>]*><img src="media\/logo\.png"/);
});

import { parseKeyframeTimes, largestKeyframeGap } from '../src/renderer.js';

test('keyframe gap parsing ignores blank lines and trailing commas', () => {
  const out = '0.000000,\n1.000000\n2.000000\n3.000000\n\n';
  const times = parseKeyframeTimes(out);
  assert.deepEqual(times, [0, 1, 2, 3]);
  assert.equal(largestKeyframeGap(times, 3.5), 1);
  assert.equal(largestKeyframeGap(parseKeyframeTimes('0.0\n8.33\n'), 17), 8.67);
  assert.equal(largestKeyframeGap([], 12), 12);
});

test('never two text layers at once: overlays don’t overlap, captions step aside in wide frames', () => {
  const plan = {
    title: 't',
    scenes: [{ ...scene('clip1', 0, 8), transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none' }],
    overlays: [
      { type: 'title', text: 'Dead aspen', subtext: '', start: 1, end: 5, position: 'center' },
      { type: 'text', text: "Client's right to ask", subtext: '', start: 3, end: 6, position: 'center' },
    ],
    audio: { fadeIn: 0, fadeOut: 0.5 },
  };
  const words = [{ word: 'hello', start: 0.2, end: 0.6 }, { word: 'during', start: 3.5, end: 3.9 }, { word: 'after', start: 6.5, end: 7 }];
  const { html, captions } = buildComposition({ plan, clips, transcripts: { clip1: { words } }, settings: { width: 1920, height: 1080, captions: 'bold' } });
  // The first overlay ends where the second begins.
  assert.match(html, /id="o0" class="clip ov ov-title pos-center" data-start="1" data-duration="2"/);
  // Landscape: no caption while any text overlay is up.
  assert.deepEqual(captions.map((c) => c.text), ['HELLO', 'AFTER']);
});

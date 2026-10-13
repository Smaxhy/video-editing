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
        scene('clip2', 4, 99, { speed: 10, transition: 'spin' }),
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

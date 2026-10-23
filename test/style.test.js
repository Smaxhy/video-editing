import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// The CI host runs unit tests before the Docker image (which has FFmpeg) is built.
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { parseCuts, rhythm, normalizeProfile, styleGuideText } from '../src/style.js';
import { sfxCues } from '../src/sfx.js';
import { LOOKS } from '../src/picture.js';

test('cut rhythm from scene-change times', () => {
  assert.deepEqual(parseCuts('[Parsed_showinfo_2 @ 0x1] n:0 pts:36 pts_time:1.2 \n... pts_time:2.45 '), [1.2, 2.45]);
  const r = rhythm([1.2, 2.4, 3.6], 6);
  assert.equal(r.shots, 4);
  assert.equal(r.avgShot, 1.5);
  assert.equal(r.firstCut, 1.2);
});

test('style profiles are validated and carry the measured pacing', () => {
  const p = normalizeProfile(
    { name: 'Arborist POV', summary: 'Calm POV work', captions: { style: 'pop', case: 'sentence', position: 'middle', highlight: '#FFAA00' }, motion: 'wild', sfx: 'off', look: 'warm', guide: ['Open on the saw starting'] },
    [{ avgShot: 1.6, wordsPerMinute: 120, talkShare: 0.4 }, { avgShot: 2.4, wordsPerMinute: 100, talkShare: 0.2 }],
  );
  assert.equal(p.captions.style, 'pop');
  assert.equal(p.captions.highlight, '#FFAA00');
  assert.equal(p.motion, 'subtle'); // unknown value → safe default
  assert.equal(p.measured.avgShot, 2);
  const guide = styleGuideText(p);
  assert.match(guide, /average shot 2s/);
  assert.match(guide, /Open on the saw starting/);
});

test('subtle sound effects skip ticks and caption pops', () => {
  const timeline = { scenes: [{ index: 0, tlStart: 0, transition: 'cut' }, { index: 1, tlStart: 3, transition: 'crossfade' }] };
  const overlays = [{ type: 'hook', start: 0 }, { type: 'text', start: 5 }, { type: 'cta', start: 9 }];
  const names = sfxCues({ timeline, overlays, emojiTimes: [6.5], level: 'subtle' }).map((c) => c.name);
  assert.deepEqual(names, ['pop', 'whoosh', 'riser', 'pop']);
});

test('every colour look is a valid FFmpeg filter chain', { skip: !HAS_FFMPEG && 'needs FFmpeg (runs inside the Docker image)' }, () => {
  for (const [name, f] of Object.entries(LOOKS)) {
    if (!f.length) continue;
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=0.2', '-vf', f.join(','), '-f', 'null', '-'], { stdio: 'pipe' });
    assert.ok(true, name);
  }
});

import { buildComposition } from '../src/renderer.js';

test('captions never overlap a title in the same part of the frame', () => {
  const words = 'watch this tree fall today'.split(' ').map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const plan = {
    title: 't',
    scenes: [{ clip: 'a', start: 0, end: 3, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none' }],
    overlays: [{ type: 'hook', text: 'Hook', start: 0, end: 1.2, position: 'center' }],
    audio: { fadeIn: 0, fadeOut: 0 },
  };
  const { captions } = buildComposition({
    plan,
    clips: [{ id: 'a', file: 'a.mp4', hasAudio: true, width: 1080, height: 1920 }],
    transcripts: { a: { words } },
    settings: { width: 1080, height: 1920, captions: 'bold', captionPos: 'middle', framing: 'crop' },
  });
  assert.ok(captions.every((c) => c.start >= 1.2 || c.end <= 0), JSON.stringify(captions));
});

import { normalizeSettingChanges, buildPrompt } from '../src/editor.js';

test('revision remarks can only change known settings to allowed values', () => {
  assert.deepEqual(normalizeSettingChanges({ polish: false, look: 'neon', captions: 'clean', music: 'off', hack: 1, musicLevel: 'loud' }), { polish: false, captions: 'clean', music: 'off' });
  assert.deepEqual(normalizeSettingChanges(null), {});
  const p = buildPrompt({
    clips: [{ id: 'clip1', name: 'a.mp4', duration: 5, width: 1080, height: 1920, hasAudio: false, transcript: null }],
    userPrompt: 'tree video',
    options: { goal: 'social', versions: ['15'], formats: [{ label: '9:16', width: 1080, height: 1920 }], captions: 'bold', revision: { remarks: 'everything looks green', previous: '{"versions":[]}', current: { polish: true } } },
  });
  assert.match(p, /REVISION/);
  assert.match(p, /everything looks green/);
  assert.match(p, /"polish": true \| false .*\(now true\)/);
});

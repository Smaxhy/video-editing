import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keepRanges, tightenPlan } from '../src/tighten.js';
import { buildComposition } from '../src/renderer.js';

const w = (word, start, end) => ({ word, start, end });

test('keepRanges cuts long pauses and fillers but leaves B-roll alone', () => {
  const words = [w('So', 0.2, 0.4), w('today', 0.45, 0.8), w('we', 0.85, 1), w('um', 1.6, 1.9), w('cut', 2.4, 2.7), w('trees', 2.75, 3.1)];
  assert.deepEqual(keepRanges(words, 0, 3.5), [[0, 1.15], [2.32, 3.5]]);
  // Hardly any speech in the range → untouched.
  assert.deepEqual(keepRanges([w('hey', 1, 1.2)], 0, 10), [[0, 10]]);
});

test('tightenPlan splits scenes, marks jump cuts and keeps overlays on their words', () => {
  const words = [w('One', 0, 0.4), w('two', 0.5, 0.9), w('three', 1, 1.4), w('four', 3.4, 3.8), w('five', 3.9, 4.3), w('six', 4.4, 4.8)];
  const plan = {
    scenes: [{ clip: 'a', start: 0, end: 5, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none' }],
    overlays: [{ type: 'text', text: 'four', start: 3.4, end: 4.4, position: 'bottom' }, { type: 'cta', text: 'Follow', start: 3, end: 5, position: 'center' }],
    audio: { fadeIn: 0, fadeOut: 0.3 },
  };
  const { plan: out, removed } = tightenPlan(plan, { a: { words } });
  assert.equal(out.scenes.length, 2);
  assert.equal(out.scenes[1].jump, true);
  assert.ok(removed > 1.5 && removed < 2, String(removed));
  const text = out.overlays.find((o) => o.type === 'text');
  // "four" now starts right after the first piece (1.55 s) + the 0.08 s lead-in.
  assert.ok(Math.abs(text.start - (out.scenes[0].end - out.scenes[0].start + 0.08)) < 0.02, JSON.stringify(text));
  const cta = out.overlays.find((o) => o.type === 'cta');
  assert.equal(cta.end, Math.round((5 - removed) * 1000) / 1000);
});

test('jump cuts alternate punch-in zoom and key words get an emphasis zoom', () => {
  const words = [w('One', 0, 0.4), w('two', 0.5, 0.9), w('three', 1, 1.4), w('timber', 3.4, 3.8), w('five', 3.9, 4.3), w('six', 4.4, 4.8), w('seven', 4.9, 5.2), w('eight', 5.3, 5.6)];
  const plan = {
    title: 't',
    scenes: [
      { clip: 'a', start: 0, end: 1.6, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none' },
      { clip: 'a', start: 2.6, end: 6.4, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none' },
    ],
    overlays: [],
    audio: { fadeIn: 0, fadeOut: 0 },
  };
  const { html } = buildComposition({
    plan,
    clips: [{ id: 'a', file: 'a.mp4', hasAudio: true, width: 1080, height: 1920 }],
    transcripts: { a: { words } },
    settings: { width: 1080, height: 1920, captions: 'off', framing: 'crop', motion: true, emphasis: [{ word: 'timber' }] },
  });
  assert.match(html, /tl\.fromTo\("#s1i", \{ scale: 1\.12 \}, \{ scale: 1\.165/);
  assert.match(html, /tl\.fromTo\("#s1p", \{ scale: 1 \}, \{ scale: 1\.07/);
});

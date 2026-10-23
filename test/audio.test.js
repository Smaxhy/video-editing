import { test } from 'node:test';
import assert from 'node:assert/strict';

import { voiceChain, hasSpeech, usedWindows } from '../src/audio.js';
import { renderWorkers, musicAutomation } from '../src/renderer.js';

test('voice chain: speech gets EQ, compression, de-essing and -16 LUFS; ambient keeps its dynamics', () => {
  const v = voiceChain({ speech: true });
  for (const f of ['highpass=f=80', 'acompressor', 'deesser', 'loudnorm=I=-16']) assert.ok(v.includes(f), f);
  const a = voiceChain({ speech: false });
  assert.ok(a.includes('loudnorm=I=-20') && !a.includes('acompressor'));
});

test('hasSpeech needs a few words inside the range', () => {
  const t = { words: [{ start: 1, end: 1.2 }, { start: 1.3, end: 1.5 }, { start: 1.6, end: 1.9 }, { start: 9, end: 9.2 }] };
  assert.equal(hasSpeech(t, 0, 3), true);
  assert.equal(hasSpeech(t, 5, 12), false);
  assert.equal(hasSpeech({ segments: [{ start: 0, end: 2, text: 'one two three' }] }), true);
  assert.equal(hasSpeech(null), false);
});

test('usedWindows covers every scene of every version, padded', () => {
  const w = usedWindows([
    { plan: { scenes: [{ clip: 'a', start: 4, end: 6 }, { clip: 'b', start: 0.2, end: 1 }] } },
    { plan: { scenes: [{ clip: 'a', start: 10, end: 12 }] } },
  ]);
  assert.deepEqual(w, { a: [3.5, 12.5], b: [0, 1.5] });
});

test('render workers: 2 on 4 cores, 1 on 2 cores', () => {
  assert.equal(renderWorkers(4), 2);
  assert.equal(renderWorkers(2), 1);
});

test('music ducking bridges short pauses and recovers smoothly', () => {
  const pts = musicAutomation([{ start: 2, end: 3 }, { start: 3.5, end: 5 }], 10, 1, 0.2);
  // One dip for both phrases (0.5 s pause is bridged), back to full after a 0.6 s ramp.
  assert.equal(pts.filter((p) => p.v === 0.2).length, 2);
  assert.ok(pts.some((p) => p.v === 1 && Math.abs(p.t - 5.7) < 0.01));
});

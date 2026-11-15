import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, onsetNear, offsetNear, refineSpeechCuts, snapToShotChanges, quantizePlan } from '../src/precision.js';

// 4 s of "speech": quiet room tone with two loud bursts at 1.00–1.50 s and 2.00–2.60 s.
function speech(sr = 16000) {
  const x = new Float32Array(sr * 4);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const loud = (t >= 1 && t < 1.5) || (t >= 2 && t < 2.6);
    x[i] = (loud ? 0.4 : 0.002) * Math.sin(2 * Math.PI * 220 * t);
  }
  return x;
}

test('precision: finds where speech really starts and ends in the loudness curve', () => {
  const c = envelope(speech());
  assert.equal(c.length, 400);
  // The transcriber said 1.08–1.42 s; the sound is 1.00–1.50 s.
  assert.ok(Math.abs(onsetNear(c, 1.08, 0.7, 1.2) - 1.0) <= 0.02);
  assert.ok(Math.abs(offsetNear(c, 1.42, 1.3, 1.9) - 1.5) <= 0.02);
  // A guess that is too early still finds the onset; constant noise finds nothing.
  assert.ok(Math.abs(onsetNear(c, 0.93, 0.6, 1.05) - 1.0) <= 0.02);
  assert.equal(onsetNear(new Int8Array(400).fill(-20), 1, 0.7, 1.2), null);
});

test('precision: speech cuts sit in the quiet gap, never inside a word', () => {
  const c = envelope(speech());
  const words = [
    { word: 'one', start: 1.08, end: 1.2 }, { word: 'two', start: 1.2, end: 1.3 }, { word: 'three', start: 1.3, end: 1.42 },
    { word: 'four', start: 2.05, end: 2.3 }, { word: 'five', start: 2.3, end: 2.45 }, { word: 'six', start: 2.45, end: 2.55 },
  ];
  const opts = { words: () => words, curve: () => c, clipDuration: () => 4, talking: () => true };
  // The planner cut at the transcribed times: 1.10 (inside the first syllable) to 1.40 (before the last one ends).
  const r = refineSpeechCuts({ scenes: [{ clip: 'a', start: 1.1, end: 1.4, speed: 1 }] }, opts);
  assert.equal(r.moved, 1);
  const sc = r.plan.scenes[0];
  assert.ok(sc.start <= 0.96 && sc.start >= 0.9, `in ${sc.start}`); // 60 ms before the real onset
  assert.ok(sc.end >= 1.6 && sc.end <= 1.7, `out ${sc.end}`); // tail rings out, well before "four" at 2.0
  // Without a loudness curve the words still bound the cut: not past the next word.
  const n = refineSpeechCuts({ scenes: [{ clip: 'a', start: 1.1, end: 1.4, speed: 1 }] }, { ...opts, curve: () => null }).plan.scenes[0];
  assert.ok(n.start < 1.08 && n.end > 1.42 && n.end < 2.05);
  // B-roll and speed-changed scenes are left alone.
  const b = refineSpeechCuts({ scenes: [{ clip: 'a', start: 1.1, end: 1.4, speed: 1 }] }, { ...opts, talking: () => false });
  assert.equal(b.moved, 0);
});

test('precision: B-roll cuts move onto the camera cut (no flash frames)', () => {
  const plan = { scenes: [{ clip: 'a', start: 4.9, end: 8.1, speed: 1 }, { clip: 'a', start: 10, end: 12, speed: 1 }] };
  const r = snapToShotChanges(plan, { shots: () => [5.0, 8.0], talking: () => false });
  assert.equal(r.moved, 1);
  assert.deepEqual([r.plan.scenes[0].start, r.plan.scenes[0].end], [5, 8]);
  assert.deepEqual(r.plan.scenes[1], plan.scenes[1]);
  assert.equal(snapToShotChanges(plan, { shots: () => [5.0], talking: () => true }).moved, 0);
});

test('precision: every shot is a whole number of frames and cuts do not drift', () => {
  // 30 shots of 0.35 s (10.5 frames each): naive rounding would drift by half a frame per shot.
  const scenes = Array.from({ length: 30 }, (_, i) => ({ clip: 'a', start: i, end: i + 0.35, speed: 1, transition: 'cut', transitionDuration: 0 }));
  const q = quantizePlan({ scenes, overlays: [{ start: 0.017, end: 2.51 }] });
  let t = 0;
  q.plan.scenes.forEach((s, i) => {
    const frames = (s.end - s.start) * 30;
    assert.ok(Math.abs(frames - Math.round(frames)) < 0.01, `shot ${i} = ${frames} frames`);
    t += s.end - s.start;
    assert.ok(Math.abs(t - (i + 1) * 0.35) <= 0.5 / 30 + 1e-3, `cut ${i} drifted ${t - (i + 1) * 0.35}`);
  });
  assert.deepEqual(q.plan.overlays[0], { start: 0.0333, end: 2.5 });
  // Slow motion: 1 s of source at 0.5× is 60 frames; a 2-frame sliver is dropped.
  const z = quantizePlan({ scenes: [{ clip: 'a', start: 0.01, end: 1.02, speed: 0.5 }, { clip: 'a', start: 3, end: 3.05, speed: 1 }, { clip: 'a', start: 5, end: 6, speed: 1 }] });
  assert.equal(z.dropped, 1);
  assert.equal(Math.round(((z.plan.scenes[0].end - z.plan.scenes[0].start) / 0.5) * 30), 61);
  // Never past the end of the clip.
  const e = quantizePlan({ scenes: [{ clip: 'a', start: 9.5, end: 10.02, speed: 1 }] }, { clipDuration: () => 10 });
  assert.ok(e.plan.scenes[0].end <= 10);
});

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

test('cutaways: anchored to the talking clip, snapped to words, never overlapping', async () => {
  const { layCutaways } = await import('../src/precision.js');
  const { layoutTimeline, buildComposition } = await import('../src/renderer.js');
  const { normalizePlan } = await import('../src/editor.js');
  const clips = [
    { id: 'talk', name: 'talk.mp4', file: 'talk.mp4', duration: 60, width: 1080, height: 1920, hasAudio: true },
    { id: 'saw', name: 'saw.mp4', file: 'saw.mp4', duration: 20, width: 1080, height: 1920, hasAudio: true },
  ];
  // The talking was tightened into two pieces: source 10–14 s then 16–22 s (output 0–4 and 4–10).
  const raw = {
    scenes: [{ clip: 'talk', start: 10, end: 22 }], // as planned; tightening then cuts 14–16 s out
    cutaways: [
      { clip: 'saw', start: 2, end: 4.5, over: 'talk', at: 11.07 }, // just after the word starting at 11.0
      { clip: 'saw', start: 8, end: 10, over: 'talk', at: 15 },     // that moment was cut → lands on the next piece
      { clip: 'saw', start: 0, end: 3, over: 'talk', at: 40 },      // not in the edit → dropped
      { clip: 'nope', start: 0, end: 3, over: 'talk', at: 12 },
    ],
    overlays: [],
  };
  const { plan } = normalizePlan(raw, clips);
  assert.equal(plan.cutaways.length, 2);
  const words = [{ start: 10.2, end: 10.6 }, { start: 11.0, end: 11.4 }, { start: 13.2, end: 13.56 }, { start: 16.1, end: 16.5 }, { start: 17.7, end: 18.02 }];
  plan.scenes = [{ ...plan.scenes[0], end: 14 }, { ...plan.scenes[0], start: 16 }];
  const laid = layoutTimeline(plan);
  const c = layCutaways(plan, laid, { words: () => words, clipDuration: () => 20 });
  assert.equal(c.length, 2);
  // In: a hair before the word at source 11.0 (output 1.0); out: after the word ending at 13.56 (output 3.56).
  assert.ok(Math.abs(c[0].tlStart - 0.97) <= 0.02, `in ${c[0].tlStart}`);
  const alone = layCutaways({ ...plan, cutaways: [plan.cutaways[0]] }, laid, { words: () => words, clipDuration: () => 20 });
  assert.ok(Math.abs(alone[0].tlStart + alone[0].duration - 3.61) <= 0.03, `out ${alone[0].tlStart + alone[0].duration}`);
  // With the next cutaway 0.4 s later, the gap is closed instead of flashing the speaker.
  assert.ok(Math.abs(c[0].tlStart + c[0].duration - c[1].tlStart) < 0.01);
  // The second one starts on the next piece (output 4.0) and they don't overlap.
  assert.ok(Math.abs(c[1].tlStart - 4.0) <= 0.04, `second ${c[1].tlStart}`);
  assert.ok(c[0].tlStart + c[0].duration <= c[1].tlStart + 1e-6);
  for (const x of c) assert.ok(Math.abs(x.duration * 30 - Math.round(x.duration * 30)) < 0.01);

  const { html } = buildComposition({
    plan: { ...plan, title: 't' },
    clips, transcripts: { talk: { words: words.map((w) => ({ ...w, word: 'word' })) } }, settings: { width: 1080, height: 1920, captions: 'off' },
  });
  assert.match(html, /<video id="kv0" src="media\/saw\.mp4" data-start="\d\.\d+" data-duration="[\d.]+" data-media-start="2" data-track-index="70" muted/);
  // The speaker's own video (and so the voice) still plays underneath for the whole time.
  assert.match(html, /<video id="v0" src="media\/talk\.mp4" data-start="0" data-duration="4"/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loudness, summarize, musicLine, alignedStart } from '../src/musicscan.js';
import { analyzeBeats } from '../src/beats.js';
import { pickTop, MUSIC_MOODS } from '../src/ml.js';
import { normalizePlan, buildPrompt } from '../src/editor.js';

/** 40 s at 128 BPM: soft kicks for 16 s, then a loud drop (kicks + noise) until the end. */
function track() {
  const SR = 22050;
  const s = new Float32Array(SR * 40);
  const beat = 60 / 128;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    const ph = t % beat;
    const kick = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-ph * 20);
    s[i] = t < 16 ? 0.05 * kick : 0.6 * kick + 0.15 * rnd();
  }
  return s;
}

test('music scan finds the tempo, the drop and the loud part', () => {
  const samples = track();
  const m = summarize(loudness(samples), analyzeBeats(samples));
  assert.ok(Math.abs(m.bpm - 128) <= 2, `bpm ${m.bpm}`);
  assert.ok(m.drop != null && Math.abs(m.drop - 16) < 1.6, `drop ${m.drop}`);
  assert.ok(m.loud.length >= 1 && m.loud[0][0] >= 14 && m.loud[0][1] >= 38, JSON.stringify(m.loud));
  assert.ok(m.intro >= 14, `intro ${m.intro}`);
  assert.equal(m.curve.length, 12);
  assert.ok(Number(m.curve[0]) <= 2 && Number(m.curve[11]) >= 7, m.curve);
  assert.ok(['medium', 'high'].includes(m.energy), m.energy);
});

test('a flat track has no drop', () => {
  const db = Array.from({ length: 120 }, () => -12);
  const m = summarize(db, { bpm: 90, downbeats: [] });
  assert.equal(m.drop, null);
});

test('the drop is aligned with the peak only when the track is long enough', () => {
  assert.equal(alignedStart({ drop: 32, duration: 120 }, { peak: 10, length: 30, fallback: 5 }), 22);
  assert.equal(alignedStart({ drop: 8, duration: 120 }, { peak: 10, length: 30, fallback: 5 }), 5); // drop before peak
  assert.equal(alignedStart({ drop: 100, duration: 110 }, { peak: 5, length: 30, fallback: 5 }), 5); // runs out
  assert.equal(alignedStart({ drop: null, duration: 110 }, { peak: 5, length: 30, fallback: 3 }), 3);
  assert.equal(alignedStart({ drop: 30, duration: 110 }, { peak: undefined, length: 30, fallback: 3 }), 3);
});

test('music line and CLAP tag picking', () => {
  const line = musicLine({ bpm: 140, energy: 'high', drop: 31.2, intro: 8, loud: [[31, 62]], curve: '123499998876', curveStep: 10 }, { genres: ['drill'], moods: ['aggressive', 'dark'] });
  assert.match(line, /140 BPM · high energy · genre: drill · mood: aggressive, dark · drop at 31.2s/);
  const scores = [{ label: MUSIC_MOODS.calm, score: 0.5 }, { label: MUSIC_MOODS.satisfying, score: 0.3 }, { label: MUSIC_MOODS.epic, score: 0.05 }];
  assert.deepEqual(pickTop(scores, MUSIC_MOODS, 3), ['calm', 'satisfying']);
});

test('plans keep one peak scene; the prompt carries what was heard and the craft rules', () => {
  const clips = [{ id: 'clip1', name: 'a.mp4', duration: 30, width: 1080, height: 1920, hasAudio: true }];
  const sc = (start, end, peak) => ({ clip: 'clip1', start, end, peak });
  const { plan } = normalizePlan({ scenes: [sc(0, 2), sc(2, 4, true), sc(4, 6, true)] }, clips);
  assert.deepEqual(plan.scenes.map((s) => Boolean(s.peak)), [false, true, false]);
  const prompt = buildPrompt({
    clips,
    userPrompt: 'make it hype',
    options: {
      goal: 'social', versions: ['30'], formats: [{ label: 'Vertical', width: 1080, height: 1920 }], captions: 'bold',
      music: { mode: 'auto', tracks: [{ id: 'm1', name: 'beat.mp3', duration: 120, tags: '', sound: '140 BPM · high energy · drop at 31.2s' }] },
    },
  });
  assert.match(prompt, /heard: 140 BPM/);
  assert.match(prompt, /"peak": true/);
  assert.match(prompt, /Match the VIBE first/);
  assert.match(prompt, /Editing craft/);
});

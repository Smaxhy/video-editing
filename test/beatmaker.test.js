import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeBeat, pickPreset, PRESETS } from '../src/beatmaker.js';
import { normalizeSettings } from '../src/autopilot.js';

test('the vibe picks a fitting music style', () => {
  assert.equal(pickPreset({ style: 'soft lo-fi beat', vibe: 'calm satisfying' }), 'lofi');
  assert.equal(pickPreset({ style: 'dark drill', vibe: 'hype' }), 'trap');
  assert.equal(pickPreset({ vibe: 'epic emotional story' }), 'cinematic');
  assert.equal(pickPreset({ style: 'upbeat pop' }), 'house');
  assert.equal(pickPreset({ energy: 'low' }), 'lofi');
  assert.equal(pickPreset(null), 'house');
});

test('composed music is long enough, on tempo, and drops on a bar at or after the peak', () => {
  for (const preset of Object.keys(PRESETS)) {
    const song = composeBeat({ preset, seconds: 20, drop: 7, seed: 3 });
    const bar = (60 / song.bpm) * 4;
    assert.ok(song.samples.length / 44100 >= 21, `${preset} long enough`);
    assert.ok(song.drop >= 7 - 0.05 && song.drop < 7 + bar, `${preset} drop ${song.drop}`);
    assert.ok(Math.abs(song.drop / bar - Math.round(song.drop / bar)) < 1e-3, 'drop on a bar line');
    assert.ok(song.downbeats.includes(song.drop), 'drop is a downbeat');
    let peak = 0;
    let quiet = 0;
    let loud = 0;
    const d = Math.round(song.drop * 44100);
    for (let i = 0; i < song.samples.length; i++) peak = Math.max(peak, Math.abs(song.samples[i]));
    for (let i = 0; i < d; i++) quiet += song.samples[i] ** 2;
    for (let i = d; i < d * 2 && i < song.samples.length; i++) loud += song.samples[i] ** 2;
    assert.ok(peak <= 0.91 && peak > 0.3, `${preset} level ${peak}`);
    assert.ok(loud > quiet * 1.3, `${preset}: the drop is bigger than the intro`);
  }
});

test('autopilot asks for a proper edit by default and keeps the music options', () => {
  const s = normalizeSettings({});
  assert.equal(s.intensity, 'creator');
  assert.equal(s.aiMusic, true);
  assert.equal(s.musicEngine, 'beat');
  const t = normalizeSettings({ intensity: 'max', aiMusic: false, musicEngine: 'musicgen' }, s);
  assert.deepEqual([t.intensity, t.aiMusic, t.musicEngine], ['max', false, 'musicgen']);
  assert.equal(normalizeSettings({ intensity: 'wild' }, t).intensity, 'max');
});

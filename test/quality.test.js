import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreQuality } from '../src/quality.js';
import { rankByEmbedding, pickSounds } from '../src/ml.js';
import { shortlist } from '../src/scanner.js';

test('quality score rewards sharp, well-exposed, steady footage and flags problems', () => {
  const good = scoreQuality({ blur: 3.8, y: 120, ylow: 30, yhigh: 210, shake: 0.5, lufs: -20, hasAudio: true });
  const bad = scoreQuality({ blur: 11, y: 40, ylow: 20, yhigh: 70, shake: 4, lufs: -60, hasAudio: true });
  assert.ok(good.score >= 90 && good.flags.length === 0, JSON.stringify(good));
  assert.ok(bad.score < 35, JSON.stringify(bad));
  assert.deepEqual(bad.flags, ['blurry', 'dark', 'flat', 'shaky', 'silent']);
});

test('search by meaning ranks clips by their best frame', () => {
  const r = rankByEmbedding([1, 0], { a: [[0, 1], [0.6, 0.8]], b: [[0.9, 0.436]] });
  assert.deepEqual(r.map((x) => x.id), ['b', 'a']);
});

test('sound tags keep confident labels and drop silence', () => {
  assert.deepEqual(pickSounds([{ label: 'chainsaw', score: 0.62 }, { label: 'wind', score: 0.27 }, { label: 'silence', score: 0.5 }, { label: 'music', score: 0.05 }]), ['chainsaw', 'wind']);
  assert.deepEqual(pickSounds([{ label: 'speech', score: 0.18 }, { label: 'wind', score: 0.1 }]), ['speech']);
});

test('shortlist boosts semantic matches and pushes unusable clips back', () => {
  const mk = (id, extra = {}) => ({ id, name: `${id}.mp4`, ai: { summary: '', tags: [] }, ...extra });
  const assets = [mk('a'), mk('b', { quality: { score: 10 } }), mk('c'), mk('d', { ai: { summary: 'chainsaw cut', tags: [] } })];
  const out = shortlist(assets, 'chainsaw', 2, [{ id: 'c' }, { id: 'b' }]);
  assert.deepEqual(out.map((a) => a.id).sort(), ['c', 'd']);
});

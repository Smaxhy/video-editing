import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reviewTimes, normalizeReview } from '../src/review.js';
import { normalizePlan } from '../src/autopilot.js';

test('review samples the hook densely, then the rest of the video', () => {
  assert.deepEqual(reviewTimes(15).slice(0, 4), [0.3, 1, 2, 3]);
  assert.ok(reviewTimes(60).length <= 12);
  assert.ok(reviewTimes(4).every((t) => t < 4));
});

test('review scores are clamped and lists capped', () => {
  const r = normalizeReview({ score: 14, hook: '6', issues: Array(10).fill('x'), summary: 'ok' });
  assert.equal(r.score, 10);
  assert.equal(r.hook, 6);
  assert.equal(r.clarity, 1);
  assert.equal(r.issues.length, 6);
});

test('Autopilot keeps the best-scoring ideas', () => {
  const out = normalizePlan(
    { ideas: [{ title: 'Meh', score: 4, clips: ['a'] }, { title: 'Great', score: 9, clips: ['a'] }, { title: 'Good', score: 7, clips: ['a'] }] },
    { known: new Set(['a']), lengths: ['15', '30'], count: 2 },
  );
  assert.deepEqual(out.ideas.map((i) => [i.title, i.score]), [['Great', 9], ['Good', 7]]);
});

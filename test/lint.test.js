import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPlan, readTime } from '../src/lint.js';

const sc = (o = {}) => ({ clip: 'a', start: 0, end: 5, speed: 1, transition: 'cut', transitionDuration: 0, ...o });
const ov = (type, text, start, end, o = {}) => ({ type, text, subtext: '', start, end, position: 'center', ...o });

test("editor's check: stock phrases and emojis go, the user's own words stay", () => {
  const plan = {
    scenes: [sc({ transition: 'fadeblack', transitionDuration: 0.5 }), sc(), sc(), sc()],
    overlays: [ov('hook', 'Wait for it… 😱', 0.4, 2), ov('text', 'Dead aspen, 60 ft 🌲', 3, 3.5), ov('text', 'Wait for it', 8, 10), ov('cta', 'Call today', 17, 20)],
    audio: { fadeIn: 1, fadeOut: 2 },
  };
  const r = lintPlan(plan, { total: 20, goal: 'social', said: 'Tree removal. Put "wait for it" before the top falls.' });
  const texts = r.plan.overlays.map((o) => o.text);
  // The hook was a stock line (not the user's exact words, which were "wait for it") → the user's line at 8 s stays.
  assert.deepEqual(texts, ['Wait for it…', 'Dead aspen, 60 ft', 'Wait for it', 'Call today']);
  assert.equal(r.plan.overlays[0].start, 0); // hook on frame one
  assert.ok(r.plan.overlays[1].end - r.plan.overlays[1].start >= readTime('Dead aspen, 60 ft') - 0.01); // readable
  assert.equal(r.plan.scenes[0].transition, 'cut');
  assert.deepEqual(r.plan.audio, { fadeIn: 0, fadeOut: 0.4 });
  assert.ok(r.fixes.some((f) => /emoji/.test(f)) && r.fixes.some((f) => /first frame/.test(f)));

  // Not the user's words → the stock hook is dropped.
  const d = lintPlan(plan, { total: 20, said: 'Tree removal video' });
  assert.deepEqual(d.plan.overlays.map((o) => o.text), ['Dead aspen, 60 ft', 'Call today']);
  assert.ok(d.fixes.some((f) => /stock line/.test(f)));
  // Emojis stay when asked for; ads may fade.
  assert.ok(lintPlan(plan, { total: 20, said: 'add emojis', goal: 'ad' }).plan.overlays.some((o) => o.text === 'Dead aspen, 60 ft 🌲'));
  assert.equal(lintPlan(plan, { total: 20, goal: 'ad' }).plan.scenes[0].transition, 'fadeblack');
});

test("editor's check: not a label on every shot — unless the user asked for text", () => {
  const overlays = [ov('hook', 'Top comes down in one cut', 0, 2), ...Array.from({ length: 8 }, (_, i) => ov('text', `Step ${i + 1} of the job`, 2.5 + i * 2, 4 + i * 2))];
  const plan = { scenes: [sc()], overlays, audio: {} };
  const r = lintPlan(plan, { total: 20 });
  assert.equal(r.plan.overlays.length, 4); // 20 s → 4 texts: the hook + 3 spread out
  assert.equal(r.plan.overlays[0].type, 'hook');
  const starts = r.plan.overlays.slice(1).map((o) => o.start);
  assert.ok(starts[2] - starts[0] >= 8, `spread out: ${starts}`);
  assert.equal(lintPlan(plan, { total: 20, keepText: true }).plan.overlays.length, 9);
  assert.equal(lintPlan(plan, { total: 20, intensity: 'max' }).plan.overlays.length, 5);
});

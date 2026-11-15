import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRetakes, dropRetakes, phrases } from '../src/retakes.js';

// Build words from text: each word 0.3 s, `|` = a 1 s pause.
function say(text, t0 = 0) {
  const words = [];
  let t = t0;
  for (const tok of text.split(/\s+/)) {
    if (tok === '|') { t += 1; continue; }
    words.push({ word: tok, start: +t.toFixed(2), end: +(t + 0.25).toFixed(2) });
    t += 0.3;
  }
  return words;
}

test('retakes: finds a repeated sentence and a false start, not ordinary speech', () => {
  const w = say("So today we're taking down this dead aspen. | So today we're taking down this dead aspen for a client. | We have a | we have a sixty foot tree right by the house. | It leans toward the roof. | It leans toward the road too.");
  assert.equal(phrases(w).length, 6);
  const r = findRetakes(w);
  assert.deepEqual(r.map((x) => x.kind), ['retake', 'false start']);
  assert.match(r[0].text, /^So today we're taking down/);
  assert.ok(r[0].drop[1] < r[0].keep[0] && r[1].drop[1] < r[1].keep[0]);
  // "It leans toward the roof." / "It leans toward the road too." are two finished, different sentences.
  assert.equal(findRetakes(say('It leans toward the roof. | It leans toward the road too.')).length, 0);
  assert.equal(findRetakes(say('Never give up. | Never stop climbing.')).length, 0);
  assert.equal(findRetakes([]).length, 0);
});

test('retakes: the earlier attempt is cut out of the edit', () => {
  const w = say("So today we're taking down this dead aspen. | So today we're taking down this dead aspen for a client. | We have a | we have a sixty foot tree.");
  const r = findRetakes(w);
  const end = w[w.length - 1].end;
  // One scene covering everything → the first take and the false start are removed.
  const one = dropRetakes({ scenes: [{ clip: 'a', start: 0, end: end + 0.2, speed: 1, transition: 'cut', transitionDuration: 0 }] }, () => r);
  assert.equal(one.removed.length, 2);
  assert.equal(one.plan.scenes.length, 2);
  assert.ok(one.plan.scenes[0].start >= r[0].drop[1]); // starts after the first take
  assert.ok(one.plan.scenes[0].end <= r[1].drop[0]); // stops before "We have a"
  assert.ok(one.plan.scenes[1].start >= r[1].drop[1]);
  // Only the first take in the edit (the planner chose it on purpose) → kept.
  const only = dropRetakes({ scenes: [{ clip: 'a', start: 0, end: r[0].drop[1] + 0.1, speed: 1 }] }, () => [r[0]]);
  assert.equal(only.removed.length, 0);
  // Other clips and sped-up scenes are untouched.
  assert.equal(dropRetakes({ scenes: [{ clip: 'b', start: 0, end: 20, speed: 1 }] }, (id) => (id === 'a' ? r : [])).removed.length, 0);
});

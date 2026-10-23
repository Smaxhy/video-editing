import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cameraPath, coverPercent } from '../src/reframe.js';
import { buildComposition } from '../src/renderer.js';

const clip = { width: 1920, height: 1080 };

test('coverPercent centres a point and clamps at the edges', () => {
  assert.equal(coverPercent(0.5, 0.5, clip, 1080, 1920).x, 50);
  assert.equal(coverPercent(0.05, 0.5, clip, 1080, 1920).x, 0);
  assert.equal(coverPercent(0.95, 0.5, clip, 1080, 1920).x, 100);
});

test('a still subject gets a locked-off crop, a moving one a smooth tracking camera', () => {
  const still = Array.from({ length: 16 }, (_, i) => ({ t: i * 0.25, x: 0.7 + (i % 2) * 0.01, y: 0.5, k: 'face' }));
  const cam = cameraPath(still, { srcStart: 0, srcEnd: 4 }, clip, 1080, 1920);
  assert.ok(cam.x > 70 && !cam.keys, JSON.stringify(cam));

  const moving = Array.from({ length: 24 }, (_, i) => ({ t: i * 0.25, x: 0.2 + i * 0.025, y: 0.5, k: 'motion' }));
  const pan = cameraPath(moving, { srcStart: 0, srcEnd: 6 }, clip, 1080, 1920);
  assert.ok(pan.keys.length >= 12);
  assert.ok(pan.keys.at(-1).x > pan.keys[0].x + 30);
  // Speed-limited: never more than 18 points between keyframes.
  assert.ok(pan.keys.every((k, i) => i === 0 || Math.abs(k.x - pan.keys[i - 1].x) <= 18.001));
});

test('smart framing animates object-position in the composition', () => {
  const track = Array.from({ length: 24 }, (_, i) => ({ t: i * 0.25, x: 0.2 + i * 0.025, y: 0.5, k: 'motion' }));
  const { html } = buildComposition({
    plan: { title: 't', scenes: [{ clip: 'a', start: 0, end: 6, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'none' }], overlays: [], audio: { fadeIn: 0, fadeOut: 0 } },
    clips: [{ id: 'a', file: 'a.mp4', hasAudio: false, width: 1920, height: 1080, track }],
    transcripts: {},
    settings: { width: 1080, height: 1920, captions: 'off', framing: 'smart' },
  });
  assert.match(html, /tl\.to\("#v0", \{ objectPosition: "\d+(\.\d+)?% 50%"/);
  assert.match(html, /object-fit: cover/);
});

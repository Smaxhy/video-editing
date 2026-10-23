import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// The CI host runs unit tests before the Docker image (which has FFmpeg) is built.
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { scheduleLines, estimateWords, mixNarration } from '../src/tts.js';
import { withNarration } from '../src/renderer.js';

test('voiceover lines never overlap and never run past the end', () => {
  const lines = [{ text: 'a', start: 0.3 }, { text: 'b', start: 1 }, { text: 'c', start: 9 }];
  const placed = scheduleLines(lines, [{ file: 'a', duration: 2 }, { file: 'b', duration: 1 }, { file: 'c', duration: 2 }], 10);
  assert.deepEqual(placed.map((l) => [l.start, l.end]), [[0.3, 2.3], [2.5, 3.5]]);
});

test('estimated word timings stay inside their line, in order', () => {
  const words = estimateWords([{ text: 'The art of tree cutting, explained.', start: 1, end: 3 }]);
  assert.equal(words.length, 6);
  assert.ok(words[0].start >= 1 && words.at(-1).end <= 3);
  assert.ok(words.every((w, i) => i === 0 || w.start >= words[i - 1].end - 1e-9));
});

test('narration captions replace overlapping clip captions', () => {
  const clipCues = [{ start: 0, end: 1, text: 'CLIP', words: [] }, { start: 5, end: 6, text: 'LATER', words: [] }];
  const out = withNarration(clipCues, { words: [{ word: 'hello', start: 0.2, end: 0.6 }, { word: 'there', start: 0.7, end: 1.1 }] }, 10, 'bold');
  assert.deepEqual(out.map((c) => c.text), ['HELLO THERE', 'LATER']);
});

test('narration lines are mixed into one level-matched track', { skip: !HAS_FFMPEG && 'needs FFmpeg (runs inside the Docker image)' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-'));
  const mk = (n) => {
    const f = path.join(dir, `l${n}.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=1', '-ar', '24000', f]);
    return f;
  };
  const out = await mixNarration([{ file: mk(1), start: 0.5, end: 1.5 }, { file: mk(2), start: 3, end: 4 }], path.join(dir, 'n.m4a'), 6);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  assert.ok(Math.abs(dur - 6) < 0.1, String(dur));
  fs.rmSync(dir, { recursive: true, force: true });
});

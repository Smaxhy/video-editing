import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDriveLink } from '../src/cloud.js';
import { sheetLayout } from '../src/library.js';
import { normalizeScan, buildFindPrompt, shortlist } from '../src/scanner.js';
import { musicAutomation } from '../src/renderer.js';
import { normalizeResponse } from '../src/editor.js';

test('parseDriveLink: folder, file and bare-id links', () => {
  assert.deepEqual(parseDriveLink('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing'), { id: '1AbCdEfGhIjKlMnOp', isFile: false });
  assert.deepEqual(parseDriveLink('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp'), { id: '1AbCdEfGhIjKlMnOp', isFile: false });
  assert.deepEqual(parseDriveLink('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view'), { id: '1AbCdEfGhIjKlMnOp', isFile: true });
  assert.deepEqual(parseDriveLink('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp'), { id: '1AbCdEfGhIjKlMnOp', isFile: false });
  assert.equal(parseDriveLink('1AbCdEfGhIjKlMnOpQrStUv').id, '1AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(parseDriveLink(''), null);
  assert.equal(parseDriveLink('not a link'), null);
});

test('sheetLayout: a frame every ~3s, 4–16 tiles, times inside the clip', () => {
  assert.equal(sheetLayout(5).count, 4);
  assert.equal(sheetLayout(30).count, 10);
  const long = sheetLayout(3600);
  assert.equal(long.count, 16);
  assert.equal(long.rows, 4);
  assert.ok(long.times.every((t) => t > 0 && t < 3600));
});

test('normalizeScan clamps moments and cleans tags', () => {
  const out = normalizeScan({
    summary: 'POV of a chainsaw felling a pine.',
    tags: ['POV', 'pov', ' Chainsaw ', ''],
    shot: 'pov',
    moments: [{ start: 5, end: 99, what: 'tree falls' }, { start: 3, end: 3.2 }],
  }, 20);
  assert.deepEqual(out.tags, ['pov', 'chainsaw']);
  assert.deepEqual(out.moments, [{ start: 5, end: 20, what: 'tree falls' }]);
  assert.equal(out.shot, 'pov');
  assert.equal(normalizeScan({ summary: 'x', shot: 'weird' }, 5).shot, 'other');
  assert.throws(() => normalizeScan({ tags: ['a'] }, 5), /summary/);
});

test('buildFindPrompt lists every scanned clip with its description', () => {
  const p = buildFindPrompt({
    brief: 'POV tree cutting',
    maxClips: 6,
    targetSeconds: 30,
    assets: [{ id: 'abc', name: 'a.mp4', duration: 12, width: 1920, height: 1080, hasAudio: true, ai: { summary: 'Chainsaw POV', tags: ['pov'], shot: 'pov', quality: 'good', moments: [] } }],
  });
  assert.match(p, /abc · "a\.mp4"/);
  assert.match(p, /Chainsaw POV/);
  assert.match(p, /at most 6 clips/);
});

test('musicAutomation ducks under speech and bridges short gaps', () => {
  const pts = musicAutomation([{ start: 2, end: 3 }, { start: 3.5, end: 5 }, { start: 9, end: 10 }], 12, 0.8, 0.2);
  const at = (t) => {
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const a = pts[i - 1], b = pts[i];
        return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
      }
    }
    return pts[pts.length - 1].v;
  };
  assert.equal(at(0.5), 0.8);
  assert.equal(at(3.2), 0.2); // gap under 1s stays ducked
  assert.equal(at(7), 0.8);
  assert.equal(at(9.5), 0.2);
  assert.equal(pts[pts.length - 1].t, 12);
  assert.ok(pts.every((p, i) => i === 0 || p.t >= pts[i - 1].t));
  assert.deepEqual(musicAutomation([], 10, 0.5, 0.1), [{ t: 0, v: 0.5 }, { t: 10, v: 0.5 }]);
});

test('normalizeResponse keeps a valid music pick and falls back for a fixed track', () => {
  const clips = [{ id: 'clip1', duration: 20, width: 1920, height: 1080, hasAudio: false }];
  const tracks = [{ id: 'm1', name: 'calm', duration: 60 }, { id: 'm2', name: 'drums', duration: 30 }];
  const base = { versions: [{ id: '15', scenes: [{ clip: 'clip1', start: 0, end: 10 }] }] };
  const auto = normalizeResponse({ ...base, music: { track: 'm2', start: 40 } }, clips, { versions: ['15'], music: { mode: 'auto', tracks } });
  assert.deepEqual(auto.music, { track: 'm2', start: 25 });
  const fixed = normalizeResponse(base, clips, { versions: ['15'], music: { mode: 'fixed', fixed: 'm1', tracks } });
  assert.deepEqual(fixed.music, { track: 'm1', start: 0 });
  // No valid pick: the user's own music still plays — the track matching the planned energy.
  const energetic = [{ ...tracks[0], sound: '70 BPM · low energy' }, { ...tracks[1], sound: '140 BPM · high energy' }];
  const none = normalizeResponse({ ...base, music: { track: 'zzz' }, sound: { energy: 'high', search: ['x'] } }, clips, { versions: ['15'], music: { mode: 'auto', tracks: energetic } });
  assert.deepEqual(none.music, { track: 'm2', start: 0 });
  assert.match(none.warnings.join(' '), /music/);
});

test('shortlist keeps the clips that match the brief when the library is huge', () => {
  const mk = (id, summary) => ({ id, name: `${id}.mp4`, ai: { summary, tags: [] } });
  const lib = [mk('a', 'city traffic'), mk('b', 'chainsaw cutting a tree, pov'), mk('c', 'beach'), mk('d', 'tree in wind')];
  assert.deepEqual(shortlist(lib, 'POV tree cutting', 2).map((x) => x.id), ['b', 'd']);
  assert.equal(shortlist(lib, 'anything', 10).length, 4);
});

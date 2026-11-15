import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCharts, matchPopular } from '../src/charts.js';
import { buildPrompt, normalizeResponse } from '../src/editor.js';

const deezer = { data: Array.from({ length: 30 }, (_, i) => ({ title: `Song ${i} (Remastered)`, title_short: `Song ${i}`, artist: { name: `Artist ${i}` }, preview: `https://cdn.example/${i}.mp3`, link: `https://deezer.example/track/${i}`, explicit_lyrics: i === 3 })) };
const apple = { feed: { results: Array.from({ length: 20 }, (_, i) => ({ name: `Hit ${i}`, artistName: `Band ${i}`, url: `https://music.example/${i}`, contentAdvisoryRating: i === 1 ? 'Explicit' : undefined })) } };
const ok = (j) => ({ ok: true, status: 200, json: async () => j });

test('charts: Deezer first, Apple as fallback, cached, and stale when offline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-charts-'));
  const cacheFile = path.join(dir, 'charts.json');
  let clock = 1_000_000;
  let calls = 0;
  let mode = 'deezer';
  const fetchImpl = async (url) => {
    calls++;
    if (mode === 'offline') throw new Error('ENOTFOUND');
    if (url.includes('deezer')) return mode === 'deezer' ? ok(deezer) : { ok: false, status: 503, json: async () => ({}) };
    return ok(apple);
  };
  try {
    const c = createCharts({ cacheFile, fetchImpl, now: () => clock, log: () => {} });
    const a = await c.top();
    assert.equal(a.source, 'Deezer chart');
    assert.deepEqual(a.songs[3], { id: 'c4', title: 'Song 3', artist: 'Artist 3', preview: 'https://cdn.example/3.mp3', link: 'https://deezer.example/track/3', explicit: true });
    await c.top();
    assert.equal(calls, 1); // cached
    // A new process within 12 h reads the disk cache.
    assert.equal((await createCharts({ cacheFile, fetchImpl, now: () => clock, log: () => {} }).top()).songs.length, 30);
    assert.equal(calls, 1);
    // Next day, Deezer is down → Apple.
    clock += 13 * 3600_000;
    mode = 'apple';
    const b = await createCharts({ cacheFile, fetchImpl, now: () => clock, log: () => {} }).top();
    assert.equal(b.source, 'Apple Music most played');
    assert.equal(b.songs[1].preview, null);
    // Offline a day later → the old list, marked stale.
    clock += 13 * 3600_000;
    mode = 'offline';
    const s = await createCharts({ cacheFile, fetchImpl, now: () => clock, log: () => {} }).top();
    assert.ok(s.stale && s.songs.length === 20);
    // Never had a list and offline → null (the feature just stays quiet).
    assert.equal(await createCharts({ cacheFile: path.join(dir, 'none.json'), fetchImpl, now: () => clock, log: () => {} }).top(), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('charts: the planner sees the list and its picks become real songs', () => {
  const songs = deezer.data.slice(0, 5).map((t, i) => ({ id: `c${i + 1}`, title: t.title_short, artist: t.artist.name, preview: t.preview, link: t.link, explicit: false }));
  const clips = [{ id: 'clip1', name: 'a.mp4', duration: 20, width: 1080, height: 1920, hasAudio: true, transcript: { words: [], text: '' } }];
  const options = { goal: 'social', versions: ['15'], formats: ['9x16'], captions: 'bold', intensity: 'natural', clipAudio: 'auto', popular: songs };
  const p = buildPrompt({ clips, userPrompt: 'tree job', options });
  assert.match(p, /### Popular songs right now[\s\S]*c2: Song 1 — Artist 1/);
  assert.match(p, /"popular": \[\{ "track": "c7"/);
  assert.ok(!buildPrompt({ clips, userPrompt: 'x', options: { ...options, popular: null } }).includes('### Popular songs right now'));

  assert.deepEqual(matchPopular([{ track: 'c2', why: 'calm build', part: 'the chorus' }, { track: 'c99' }, { track: 'c2' }], songs),
    [{ title: 'Song 1', artist: 'Artist 1', preview: 'https://cdn.example/1.mp3', link: 'https://deezer.example/track/1', explicit: false, why: 'calm build', part: 'the chorus' }]);
  const raw = { title: 't', versions: [{ id: '15', scenes: [{ clip: 'clip1', start: 0, end: 10 }], overlays: [] }], sound: { vibe: 'calm', search: ['lofi'], popular: [{ track: 'c3', why: 'fits' }] } };
  const out = normalizeResponse(raw, clips, options);
  assert.equal(out.sound.popular[0].title, 'Song 2');
});

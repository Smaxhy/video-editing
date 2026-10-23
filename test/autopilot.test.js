import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAutopilot, normalizePlan, normalizeSettings, normalizeHashtags, nextRunAt, slugify, buildPlanPrompt, DEFAULT_SETTINGS } from '../src/autopilot.js';

const DAY = 24 * 60 * 60_000;

test('normalizePlan keeps real clips, allowed lengths and tidy hashtags', () => {
  const out = normalizePlan(
    {
      plan: 'Lean into the chainsaw POV.',
      ideas: [
        { title: 'The art of tree cutting', vibe: 'cinematic', clips: ['a1', 'nope', 'a2', 'a1'], length: '60s', captionStyle: 'loud', accent: '#FFCC00', caption: 'Timber.', hashtags: 'treework, #chainsaw #Chainsaw pov!' },
        { title: 'No clips', clips: ['zzz'] },
        { title: '', clips: ['a1'] },
        { title: 'Extra', clips: ['a2'], length: '15' },
      ],
    },
    { known: new Set(['a1', 'a2']), lengths: ['15', '30'], count: 1 },
  );
  assert.equal(out.plan, 'Lean into the chainsaw POV.');
  assert.equal(out.ideas.length, 1);
  const [i] = out.ideas;
  assert.deepEqual(i.assetIds, ['a1', 'a2']);
  assert.equal(i.length, '30'); // 60 not allowed → the middle of what is
  assert.equal(i.captionStyle, 'bold');
  assert.equal(i.accent, '#FFCC00');
  assert.deepEqual(i.hashtags, ['#treework', '#chainsaw', '#pov']);
});

test('settings are clamped and keep previous values', () => {
  const s = normalizeSettings({ everyDays: 99, perBatch: 0, lengths: ['full', '60'], enabled: true }, DEFAULT_SETTINGS);
  assert.equal(s.everyDays, 14);
  assert.equal(s.perBatch, 1);
  assert.deepEqual(s.lengths, ['60']);
  assert.equal(s.enabled, true);
  assert.equal(normalizeSettings({ direction: 'chill' }, s).everyDays, 14);
});

test('nextRunAt: right away the first time, every N days after, an hour after a failure', () => {
  const settings = { ...DEFAULT_SETTINGS, enabled: true, everyDays: 2 };
  assert.equal(nextRunAt({ settings, lastRun: null }), 0);
  assert.equal(nextRunAt({ settings, lastRun: 1000 }), 1000 + 2 * DAY);
  assert.equal(nextRunAt({ settings, lastRun: 1000, failedAt: 5000 }), 5000 + 60 * 60_000);
  assert.equal(nextRunAt({ settings: { ...settings, enabled: false }, lastRun: 1000 }), null);
});

test('slugify and hashtags', () => {
  assert.equal(slugify('POV: The Art of Tree-Cutting!'), 'pov-the-art-of-tree-cutting');
  assert.equal(slugify('🔥🔥'), 'video');
  assert.equal(normalizeHashtags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 15);
});

test('buildPlanPrompt lists the library, the direction and recent ideas to avoid', () => {
  const p = buildPlanPrompt({
    assets: [{ id: 'a1', name: 'saw.mp4', duration: 12, width: 1080, height: 1920, hasAudio: true, ai: { summary: 'Chainsaw POV', tags: ['pov'], shot: 'pov', quality: 'good' } }],
    settings: { ...DEFAULT_SETTINGS, direction: 'tree work content' },
    count: 3,
    recent: ['Old idea (hype)'],
  });
  assert.match(p, /a1 · "saw.mp4"/);
  assert.match(p, /tree work content/);
  assert.match(p, /Old idea \(hype\)/);
  assert.match(p, /3 short vertical videos/);
});

test('a batch plans, renders every idea and leaves video + caption files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-'));
  const src = path.join(dir, 'render.mp4');
  fs.writeFileSync(src, 'fake mp4');
  const assets = [
    { id: 'a1', kind: 'video', status: 'ready', name: 'saw.mp4', duration: 10, width: 1920, height: 1080, ai: { status: 'done', summary: 'chainsaw' } },
    { id: 'a2', kind: 'video', status: 'ready', name: 'fall.mp4', duration: 8, width: 1920, height: 1080, ai: { status: 'pending' } },
  ];
  let scanned = [];
  const library = { list: () => assets };
  const scanner = {
    async scanNow(ids) {
      scanned = ids;
      for (const a of assets) a.ai.status = 'done';
    },
  };
  const plan = async () =>
    JSON.stringify({
      plan: 'Two moods.',
      ideas: [
        { title: 'Calm cut', vibe: 'cinematic', clips: ['a1', 'a2'], length: '30', caption: 'Slow down.', hashtags: ['#trees'] },
        { title: 'Hype cut', vibe: 'hype', clips: ['a2'], length: '15', caption: 'Go!', hashtags: ['#chainsaw'] },
      ],
    });
  const rendered = [];
  const renderIdea = async (idea, { prompt, settings, onJob }) => {
    onJob(`job-${idea.id}`);
    rendered.push({ idea, prompt, settings });
    return { jobId: `job-${idea.id}`, file: src, poster: null, duration: Number(idea.length), size: 8, width: 1080, height: 1920 };
  };
  const events = [];
  const ap = createAutopilot({ dir, library, scanner, renderIdea, plan, onChange: (e) => events.push(e) });
  await ap.setSettings({ perBatch: 2, lengths: ['15', '30'], cta: 'Follow for more' });
  assert.ok(ap.runNow());
  assert.equal(ap.runNow(), null); // one batch at a time
  while (ap.busy()) await new Promise((r) => setTimeout(r, 5));
  await ap.settled();

  assert.deepEqual(scanned, ['a2']);
  const st = ap.status();
  const [b] = st.batches;
  assert.equal(b.status, 'done');
  assert.equal(b.plan, 'Two moods.');
  assert.deepEqual(b.ideas.map((i) => i.status), ['done', 'done']);
  assert.equal(rendered[0].settings.lengths[0], '30');
  assert.equal(rendered[0].settings.formats[0], '9x16');
  assert.match(rendered[0].prompt, /Follow for more/);
  assert.equal(b.ideas[0].file, '01-calm-cut.mp4');
  assert.ok(fs.existsSync(path.join(dir, b.id, '01-calm-cut.mp4')));
  assert.match(fs.readFileSync(path.join(dir, b.id, '02-hype-cut.txt'), 'utf8'), /Go!\n\n#chainsaw/);
  assert.ok(ap.filePath(b.id, '01-calm-cut.txt'));
  assert.equal(ap.filePath(b.id, '../autopilot.json'), null);
  assert.equal(ap.batchFiles(b.id).length, 4);
  assert.ok(st.lastRun);
  assert.ok(events.some((e) => e.type === 'autopilot'));

  // State survives a restart.
  const again = createAutopilot({ dir, library, scanner, renderIdea, plan });
  assert.equal(again.status().batches[0].ideas.length, 2);
  await again.removeBatch(b.id);
  assert.ok(!fs.existsSync(path.join(dir, b.id)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed render keeps the other videos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-'));
  const src = path.join(dir, 'render.mp4');
  fs.writeFileSync(src, 'x');
  const assets = [{ id: 'a1', kind: 'video', status: 'ready', name: 'a.mp4', ai: { status: 'done' } }];
  const plan = async () => JSON.stringify({ ideas: [{ title: 'One', clips: ['a1'] }, { title: 'Two', clips: ['a1'] }] });
  let n = 0;
  const renderIdea = async () => {
    if (n++ === 0) throw new Error('boom');
    return { jobId: 'j', file: src, duration: 15, size: 1 };
  };
  const ap = createAutopilot({ dir, library: { list: () => assets }, scanner: { scanNow: async () => {} }, renderIdea, plan });
  await ap.setSettings({ perBatch: 2 });
  ap.runNow();
  while (ap.busy()) await new Promise((r) => setTimeout(r, 5));
  const [b] = ap.status().batches;
  assert.equal(b.status, 'done');
  assert.deepEqual(b.ideas.map((i) => i.status), ['error', 'done']);
  assert.equal(b.ideas[0].error.message, 'boom');
  await ap.settled();
  fs.rmSync(dir, { recursive: true, force: true });
});

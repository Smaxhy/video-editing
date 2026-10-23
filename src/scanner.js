import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { callClaude, extractJson } from './editor.js';
import { PipelineError, round } from './util.js';

/**
 * AI footage scanner. Claude looks at each video's contact sheet (a grid of frames) and writes
 * down what's in it — summary, search tags, camera style, best moments — so the library can be
 * searched by content and the edit planner can pick footage from the whole library.
 *
 * Runs on your Claude subscription through `claude -p`, several clips per call. With auto-scan on,
 * every new video is scanned once its previews are ready.
 */

const PARALLEL = Math.max(1, Number(process.env.CLIPFORGE_SCAN_PARALLEL) || 3);
const BATCH = 6;
const SHOTS = ['pov', 'handheld', 'gimbal', 'static', 'drone', 'talking-head', 'screen-recording', 'timelapse', 'slow-motion', 'other'];
const fmtT = (t) => `${round(t, 1)}s`;
// File names come from wherever the footage came from — quote them so odd characters can't bend the prompt.
const q = (name) => JSON.stringify(String(name).slice(0, 120));
const MAX_INDEX = 400;

/**
 * Keep the prompt a sensible size on big libraries: rank clips by how many words of the brief
 * appear in their description/tags/name and keep the top MAX_INDEX.
 */
/**
 * The clips worth showing Claude for a brief when the library is too big for one prompt: keyword
 * matches on the AI descriptions/sound tags, boosted by "search by meaning" (CLIP) when available,
 * with clearly unusable footage (measured quality under 35) pushed to the back.
 */
export function shortlist(assets, brief, max = MAX_INDEX, semantic = []) {
  if (assets.length <= max) return assets;
  const words = [...new Set(String(brief).toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
  const sem = new Map(semantic.map((r, i) => [r.id, 1 - i / Math.max(1, semantic.length)]));
  const score = (a) => {
    const text = [a.name, a.ai?.summary, ...(a.ai?.tags || []), ...(a.sounds || [])].join(' ').toLowerCase();
    const kw = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    const bad = a.quality?.score != null && a.quality.score < 35 ? 2 : 0;
    return kw + 3 * (sem.get(a.id) || 0) - bad;
  };
  return assets.map((a) => ({ a, s: score(a) })).sort((x, y) => y.s - x.s).slice(0, max).map((x) => x.a);
}

export function buildScanPrompt(items) {
  const list = items
    .map((it) => `- id: ${it.id} · file name: ${q(it.name)} · ${fmtT(it.duration)} · ${it.width}x${it.height}${it.hasAudio ? '' : ' · no audio'}
  image: ${it.image} · tiles (left→right, top→bottom): ${it.times.map((t, i) => `${i + 1}@${fmtT(t)}`).join(', ')}`)
    .join('\n');
  return `You are cataloguing raw video clips so an editor can search footage by what's in it.
Each clip below has a contact-sheet image in the current directory: a grid of frames from the clip, read left→right, top→bottom; tile k shows the source time listed.
Use the Read tool to open EVERY image before answering. The file name can hint at content but trust the frames.

## Clips
${list}

## For each clip write
- "summary": 1-2 concrete sentences — who/what is shown, the action, the place, the camera perspective (e.g. "First-person POV of a logger cutting a pine with a chainsaw in a snowy forest.").
- "tags": 8-15 lowercase search words: subjects, actions, objects, setting, time of day, mood, camera style (pov, drone, close-up, wide, slow-motion…), people/no-people.
- "shot": one of ${SHOTS.join(' | ')}.
- "quality": "good" | "ok" | "poor", plus a few words on blur, exposure or shake.
- "moments": 1-4 of the most usable or striking ranges in SOURCE seconds, using the tile times: { "start": 12, "end": 20, "what": "tree falls" }.

## Response
ONE JSON object, nothing else:
{"clips":[{"id":"…","summary":"…","tags":["…"],"shot":"pov","quality":"good — sharp, steady","moments":[{"start":0,"end":4,"what":"…"}]}]}`;
}

/** Validate one clip's scan against its real duration. */
export function normalizeScan(raw, duration) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const tags = [...new Set((Array.isArray(raw?.tags) ? raw.tags : []).map((t) => String(t).toLowerCase().trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  const moments = (Array.isArray(raw?.moments) ? raw.moments : [])
    .map((m) => {
      const start = Math.max(0, Math.min(duration, num(m?.start, 0)));
      const end = Math.max(0, Math.min(duration, num(m?.end, start + 3)));
      return end - start >= 0.5 ? { start: round(start, 1), end: round(end, 1), what: String(m?.what || '').slice(0, 140) } : null;
    })
    .filter(Boolean)
    .slice(0, 4);
  const summary = String(raw?.summary || '').trim().slice(0, 400);
  if (!summary) throw new Error('no summary');
  return {
    summary,
    tags,
    shot: SHOTS.includes(raw?.shot) ? raw.shot : 'other',
    quality: String(raw?.quality || '').slice(0, 80),
    moments,
  };
}

/** One line per scanned clip for the footage finder. */
export function indexLine(a) {
  const ai = a.ai || {};
  const moments = (ai.moments || []).map((m) => `${m.start}-${m.end}s ${m.what}`).join('; ');
  const measured = a.quality?.score != null ? ` · measured ${a.quality.score}/100${a.quality.flags?.length ? ` (${a.quality.flags.join(', ')})` : ''}` : '';
  const sounds = a.sounds?.length ? `\n  sounds: ${a.sounds.join(', ')}` : '';
  return `- ${a.id} · ${q(a.name)} · ${fmtT(a.duration)} · ${a.width}x${a.height}${a.hasAudio ? '' : ' · silent'} · ${ai.shot || '?'} · quality: ${ai.quality || '?'}${measured}
  ${ai.summary || '(not scanned)'}
  tags: ${(ai.tags || []).join(', ')}${moments ? `\n  moments: ${moments}` : ''}${sounds}`;
}

export function buildFindPrompt({ brief, assets, maxClips, targetSeconds }) {
  return `You are the footage researcher for a video editor. Pick the clips from the library below that best fit the user's request.
Each clip was described by an AI that looked at its frames.

## User's request
"""
${brief}
"""

## Target
Final video about ${targetSeconds ? `${targetSeconds} seconds` : 'whatever length the request implies'}. Pick at most ${maxClips} clips — enough usable footage to cut that length with variety, not everything that vaguely matches.
Prefer clips that match the subject AND the requested style (e.g. "POV" means first-person shots). Skip poor-quality clips unless nothing better exists. Order the picks the way they'd best tell the story.
If nothing in the library fits, return an empty list and explain in "note".

## Library (${assets.length} clips)
${assets.map(indexLine).join('\n')}

## Response
ONE JSON object, nothing else:
{"picks":[{"id":"<clip id>","why":"short reason"}],"note":"one sentence on what you found or what's missing"}`;
}

export function createScanner({ library, dir, onChange = () => {}, rank = null }) {
  const work = path.join(dir, '.scan');
  const settingsFile = path.join(dir, '.scanner.json');
  let settings = { autoScan: true };
  try {
    settings = { ...settings, ...JSON.parse(fsSync.readFileSync(settingsFile, 'utf8')) };
  } catch {
    /* defaults */
  }
  const queue = [];
  const scanning = new Set();
  let working = false;
  let lastError = null;

  const status = () => ({
    autoScan: settings.autoScan,
    queued: queue.length,
    scanning: scanning.size,
    lastError,
  });
  const emit = () => onChange({ type: 'scanner', scanner: status() });
  const scannable = (a) => a && (a.kind || 'video') === 'video' && a.status === 'ready';

  function enqueue(ids) {
    for (const id of ids) {
      const a = library.get(id);
      if (!scannable(a) || queue.includes(id) || scanning.has(id)) continue;
      queue.push(id);
      library.setAI(id, { ...(a.ai || {}), status: 'queued' });
    }
    emit();
    if (!working) drain();
  }

  async function drain() {
    working = true;
    // Let a burst of uploads settle so they share one Claude call.
    await new Promise((r) => setTimeout(r, 2000));
    // Claude calls wait on the network, not this machine, so a few run side by side.
    const worker = async () => {
      while (queue.length) {
        const ids = queue.splice(0, BATCH);
        try {
          await scanBatch(ids);
        } catch (err) {
          lastError = err.message;
          // Out of usage / not logged in: stop instead of failing every remaining clip.
          if (/limit|log ?in|auth|not installed/i.test(`${err.message} ${err.hint || ''}`)) {
            for (const id of queue.splice(0)) library.setAI(id, { status: 'none' });
          }
        }
        emit();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    working = false;
    emit();
  }

  /** Scan up to BATCH clips in one Claude call. Throws only when the call itself fails. */
  async function scanBatch(ids, { signal } = {}) {
    const batchDir = path.join(work, crypto.randomBytes(4).toString('hex'));
    await fs.mkdir(batchDir, { recursive: true });
    const items = [];
    try {
      for (const id of ids) {
        const a = library.get(id);
        if (!scannable(a) || !(await library.ensureSheet(id))) {
          if (a) await library.setAI(id, { status: 'error', error: 'Could not grab frames from this video.' });
          continue;
        }
        scanning.add(id);
        await library.setAI(id, { ...(a.ai || {}), status: 'scanning' });
        await fs.copyFile(library.sheetPath(id), path.join(batchDir, `${id}.jpg`));
        items.push({ ...a, image: `${id}.jpg`, times: library.get(id).preview.sheet.times });
      }
      if (!items.length) return;
      emit();
      let raw;
      try {
        raw = extractJson(await callClaude(buildScanPrompt(items), { cwd: batchDir, tools: 'Read', signal }));
      } catch (err) {
        for (const it of items) await library.setAI(it.id, { status: 'error', error: err.message });
        throw err;
      }
      const byId = new Map((Array.isArray(raw.clips) ? raw.clips : []).map((c) => [String(c?.id), c]));
      for (const it of items) {
        try {
          const ai = normalizeScan(byId.get(it.id), it.duration);
          await library.setAI(it.id, { status: 'done', ...ai, scannedAt: Date.now() });
        } catch {
          await library.setAI(it.id, { status: 'error', error: 'Claude skipped this clip — try rescanning.' });
        }
      }
      lastError = null;
    } finally {
      for (const it of items) scanning.delete(it.id);
      await fs.rm(batchDir, { recursive: true, force: true });
    }
  }

  return {
    status,
    settings: () => ({ ...settings }),
    async setSettings(patch) {
      settings = { ...settings, ...patch };
      await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
      if (settings.autoScan) enqueue(library.list().filter((a) => a.ai.status === 'none').map((a) => a.id));
      emit();
      return status();
    },
    /** Resume after a restart; auto-scan anything that's never been scanned. */
    load() {
      const pending = library.list().filter((a) => ['queued', 'scanning'].includes(a.ai.status) || (settings.autoScan && a.ai.status === 'none'));
      if (pending.length) enqueue(pending.map((a) => a.id));
    },
    /** Called by the library when an asset's previews are done. */
    onReady(a) {
      if (settings.autoScan && (!a.ai || a.ai.status === 'none')) enqueue([a.id]);
    },
    /** Queue specific clips (rescan button). */
    rescan(ids) {
      for (const id of ids) library.setAI(id, { status: 'none' });
      enqueue(ids);
    },

    /**
     * Make sure every given clip is scanned, now (used by the edit pipeline). Clips already being
     * scanned in the background are waited for rather than scanned twice.
     */
    async scanNow(ids, { signal, onProgress } = {}) {
      const todo = ids.filter((id) => library.get(id)?.ai?.status !== 'done');
      for (const id of todo) {
        const i = queue.indexOf(id);
        if (i >= 0) queue.splice(i, 1);
      }
      const mine = todo.filter((id) => !scanning.has(id));
      let done = 0;
      onProgress?.(0, todo.length);
      const batches = [];
      for (let i = 0; i < mine.length; i += BATCH) batches.push(mine.slice(i, i + BATCH));
      const worker = async () => {
        while (batches.length) {
          if (signal?.aborted) throw new PipelineError('Cancelled.');
          const batch = batches.shift();
          await scanBatch(batch, { signal });
          done += batch.length;
          onProgress?.(done, todo.length);
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      while (todo.some((id) => scanning.has(id))) {
        if (signal?.aborted) throw new PipelineError('Cancelled.');
        await new Promise((r) => setTimeout(r, 1000));
      }
      emit();
    },

    /**
     * Ask Claude which library clips fit a brief. Returns [{ id, why }] (ids validated) and a note.
     */
    async findFootage({ brief, maxClips = 10, targetSeconds, signal, cwd }) {
      const assets = library.list().filter((a) => a.kind === 'video' && a.ai.status === 'done');
      if (!assets.length) {
        throw new PipelineError('No scanned videos in your library yet.', { hint: 'Upload or import videos first — Claude scans them so it can pick footage.' });
      }
      const semantic = rank && assets.length > MAX_INDEX ? await rank(brief).catch(() => []) : [];
      const raw = extractJson(await callClaude(buildFindPrompt({ brief, assets: shortlist(assets, brief, MAX_INDEX, semantic), maxClips, targetSeconds }), { cwd, signal }));
      const known = new Set(assets.map((a) => a.id));
      const seen = new Set();
      const picks = (Array.isArray(raw.picks) ? raw.picks : [])
        .map((p) => ({ id: String(p?.id || '').trim(), why: String(p?.why || '').slice(0, 200) }))
        .filter((p) => known.has(p.id) && !seen.has(p.id) && seen.add(p.id))
        .slice(0, maxClips);
      return { picks, note: String(raw.note || '').slice(0, 300) };
    },
  };
}

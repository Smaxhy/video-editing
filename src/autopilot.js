import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { indexLine, shortlist } from './scanner.js';
import { callClaude, extractJson, PLANNER_MODELS } from './editor.js';
import { PipelineError } from './util.js';

/**
 * Autopilot: every few days Claude looks over the whole (scanned) library, writes a short content
 * plan and several video ideas in different vibes — each with its own clips, caption and hashtags —
 * then renders them one by one. The finished videos land in one folder per batch as plain files
 * (MP4 + a caption .txt) the user downloads and posts themselves. Nothing is uploaded anywhere.
 */

const DAY = 24 * 60 * 60_000;
const RETRY_AFTER_FAIL = 60 * 60_000;
export const AUTOPILOT_LENGTHS = ['15', '30', '60'];
export const AUTOPILOT_CAPTIONS = ['bold', 'clean', 'off'];
const MAX_BATCHES = 30;
const MAX_IDEA_CLIPS = 12;

export const DEFAULT_SETTINGS = {
  enabled: false,
  everyDays: 3,
  perBatch: 3,
  lengths: ['15', '30'],
  direction: '',
  brand: '',
  cta: '',
  plannerModel: 'sonnet',
  voiceover: 'auto',
  voice: 'am_michael',
};
const VOICE_IDS = ['am_michael', 'am_fenrir', 'am_puck', 'am_onyx', 'bm_george', 'bm_fable', 'af_heart', 'af_bella', 'af_nicole', 'bf_emma'];

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);

export function normalizeSettings(s = {}, prev = DEFAULT_SETTINGS) {
  const lengths = (Array.isArray(s.lengths) ? s.lengths : prev.lengths).map(String).filter((l) => AUTOPILOT_LENGTHS.includes(l));
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : prev.enabled,
    everyDays: s.everyDays == null ? prev.everyDays : clamp(s.everyDays, 1, 14, prev.everyDays),
    perBatch: s.perBatch == null ? prev.perBatch : clamp(s.perBatch, 1, 6, prev.perBatch),
    lengths: lengths.length ? [...new Set(lengths)] : prev.lengths,
    direction: s.direction == null ? prev.direction : String(s.direction).trim().slice(0, 1500),
    brand: s.brand == null ? prev.brand : clean(s.brand, 60),
    cta: s.cta == null ? prev.cta : clean(s.cta, 60),
    plannerModel: PLANNER_MODELS.includes(s.plannerModel) ? s.plannerModel : prev.plannerModel,
    voiceover: ['off', 'auto', 'on'].includes(s.voiceover) ? s.voiceover : prev.voiceover || 'auto',
    voice: VOICE_IDS.includes(s.voice) ? s.voice : prev.voice || 'am_michael',
  };
}

/** When the next automatic batch is due: everyDays after the last one, or an hour after a failed try. */
export function nextRunAt({ settings, lastRun, failedAt }) {
  if (!settings.enabled) return null;
  if (failedAt && (!lastRun || failedAt > lastRun)) return failedAt + RETRY_AFTER_FAIL;
  return lastRun ? lastRun + settings.everyDays * DAY : 0; // never ran → right away
}

export const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '') || 'video';

export function normalizeHashtags(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const word = String(t).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(`#${word}`);
    if (out.length >= 15) break;
  }
  return out;
}

export function buildPlanPrompt({ assets, settings, count, recent, candidates = count }) {
  return `You are the content strategist and video producer for a short-form creator (Instagram Reels / TikTok / Shorts).
Below is their whole footage library — an AI watched every clip and described it. Plan the next batch of ${count} short vertical videos made ONLY from this footage.
Brainstorm ${candidates} candidate ideas and give each a "score" (1-10): how likely it is to stop the scroll and get watched to the end, judged by the strength of the hook and how well the footage supports it. Only the ${count} best-scoring ideas will be made, so be critical.

## What the creator wants
${settings.direction ? `"""\n${settings.direction}\n"""` : '(No direction given — work out what the footage is about and what would perform well with it.)'}
${settings.brand ? `Brand / account name: ${settings.brand}\n` : ''}${settings.cta ? `Call to action they like: ${settings.cta}\n` : ''}
## Rules
- ${candidates} ideas, each a DIFFERENT vibe (for example: cinematic & calm, hype & fast cuts, satisfying ASMR, educational / how-to, funny, story / day-in-the-life, motivational). No two ideas should feel alike.
- Each idea uses 2–${MAX_IDEA_CLIPS} clips from the library (by id) that genuinely fit it, in story order. Different ideas may reuse a clip, but vary them where you can. Prefer good-quality clips.
- Length per idea: one of ${settings.lengths.map((l) => `"${l}"`).join(', ')} seconds — pick what suits the idea and the amount of fitting footage.
- "brief" is the instruction for the video editor: the hook in the first 2 seconds, pacing, what on-screen text/subtitles to show, the mood of the music, how it ends. Concrete, 2–5 sentences.
- "hook" is the short on-screen hook text (max 8 words).
- "caption" is the ready-to-post caption: a strong first line, 1–3 short lines, maybe an emoji or two, ending with a question or call to action. No hashtags in the caption.
- "hashtags": 8–15 relevant hashtags, mixing broad and niche.
- "captionStyle": "bold" (big punchy subtitles), "clean" (small tidy subtitles) or "off" (no subtitles — only for purely visual vibes).
- "accent": a hex colour for on-screen text that matches the vibe.
${recent.length ? `- These were made recently — do NOT repeat them, find fresh angles:\n${recent.map((r) => `  - ${r}`).join('\n')}\n` : ''}
## Library (${assets.length} clips)
${assets.map(indexLine).join('\n')}

## Response
Reply with ONLY this JSON (no prose):
{"plan":"2–4 sentences: the content strategy for this batch and why it fits the footage",
 "ideas":[{"title":"short title","score":8,"vibe":"2–4 words","hook":"…","brief":"…","clips":["<clip id>",…],"length":"30","captionStyle":"bold","accent":"#ffcc00","caption":"…","hashtags":["#…",…]}]}`;
}

/** Validate Claude's plan against the library: real clip ids only, allowed lengths, tidy text. */
export function normalizePlan(raw, { known, lengths, count }) {
  const ideas = [];
  // Best first: Claude scored every candidate; only the top `count` are made.
  const ranked = (Array.isArray(raw?.ideas) ? raw.ideas : [])
    .map((it, i) => ({ it, i, score: Number.isFinite(Number(it?.score)) ? Number(it.score) : 5 }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  for (const { it, score } of ranked) {
    const seen = new Set();
    const assetIds = (Array.isArray(it?.clips) ? it.clips : [])
      .map((c) => String(c?.id ?? c).trim())
      .filter((id) => known.has(id) && !seen.has(id) && seen.add(id))
      .slice(0, MAX_IDEA_CLIPS);
    const title = clean(it?.title, 80);
    if (!assetIds.length || !title) continue;
    const length = String(it?.length ?? '').replace(/s$/i, '');
    ideas.push({
      id: crypto.randomUUID().slice(0, 8),
      title,
      vibe: clean(it?.vibe, 40),
      hook: clean(it?.hook, 80),
      brief: String(it?.brief || '').trim().slice(0, 1500),
      assetIds,
      length: lengths.includes(length) ? length : lengths[Math.min(1, lengths.length - 1)] || '30',
      captionStyle: AUTOPILOT_CAPTIONS.includes(it?.captionStyle) ? it.captionStyle : 'bold',
      accent: /^#[0-9a-f]{6}$/i.test(it?.accent || '') ? it.accent : null,
      caption: String(it?.caption || '').trim().slice(0, 2000),
      hashtags: normalizeHashtags(it?.hashtags),
      score: clamp(Math.round(score), 1, 10, 5),
      status: 'queued',
    });
    if (ideas.length >= count) break;
  }
  return { plan: String(raw?.plan || '').trim().slice(0, 1200), ideas };
}

/** What the editor is told for one idea (it already gets the clips; this is the creative brief). */
export function ideaPrompt(idea, settings) {
  return [
    `Make a ${idea.length}-second vertical social video: "${idea.title}".`,
    idea.vibe && `Vibe: ${idea.vibe}.`,
    idea.hook && `Open with this on-screen hook: "${idea.hook}".`,
    idea.brief,
    settings.cta && `End with this call to action: "${settings.cta}".`,
  ]
    .filter(Boolean)
    .join('\n');
}

export const captionText = (idea) => [idea.title, '', idea.caption, '', idea.hashtags.join(' ')].join('\n').trim() + '\n';

async function linkOrCopy(from, to) {
  await fs.rm(to, { force: true });
  try {
    await fs.link(from, to); // same disk → no extra space
  } catch {
    await fs.copyFile(from, to);
  }
}

/**
 * @param {object} o
 * @param {string} o.dir              where autopilot.json and the batch folders live
 * @param {object} o.library
 * @param {object} o.scanner
 * @param {Function} o.renderIdea     (idea, {prompt, settings, signal, onProgress}) → {jobId, file, poster, duration, size, width, height}
 * @param {Function} o.otherWork      → reason string while something else is rendering (autopilot waits), else falsy
 * @param {Function} o.onChange       broadcast (type 'autopilot')
 * @param {Function} [o.plan]         injectable Claude call for tests
 */
export function createAutopilot({ dir, library, scanner, renderIdea, otherWork = () => false, onChange = () => {}, plan = callClaude, now = Date.now }) {
  const file = path.join(dir, 'autopilot.json');
  let data = { settings: { ...DEFAULT_SETTINGS }, lastRun: null, failedAt: null, batches: [] };
  let current = null; // { batchId, abort, phase, message }
  let timer = null;

  try {
    const saved = JSON.parse(fsSync.readFileSync(file, 'utf8'));
    data = { ...data, ...saved, settings: normalizeSettings(saved.settings || {}, DEFAULT_SETTINGS) };
  } catch {
    /* first run */
  }

  let saving = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(data, null, 2);
    saving = saving.then(async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${file}.tmp`, snapshot);
      await fs.rename(`${file}.tmp`, file);
    }).catch((err) => console.error('[autopilot] could not save:', err.message));
    return saving;
  };

  const batchDir = (b) => path.join(dir, b.id);
  const publicIdea = (b, i) => ({
    id: i.id,
    title: i.title,
    vibe: i.vibe,
    hook: i.hook,
    length: i.length,
    caption: i.caption,
    hashtags: i.hashtags,
    captionText: captionText(i),
    clips: i.assetIds.length,
    score: i.score || null,
    review: i.review || null,
    status: i.status,
    message: i.message || '',
    progress: i.progress || 0,
    error: i.error || null,
    jobId: i.jobId || null,
    duration: i.duration || null,
    size: i.size || null,
    width: i.width || null,
    height: i.height || null,
    file: i.file || null,
    videoUrl: i.file ? `/api/autopilot/file/${b.id}/${encodeURIComponent(i.file)}?inline=1` : null,
    downloadUrl: i.file ? `/api/autopilot/file/${b.id}/${encodeURIComponent(i.file)}` : null,
    posterUrl: i.poster ? `/api/autopilot/file/${b.id}/${encodeURIComponent(i.poster)}?inline=1` : null,
  });
  const publicBatch = (b) => ({
    id: b.id,
    createdAt: b.createdAt,
    status: b.status,
    plan: b.plan || '',
    error: b.error || null,
    auto: Boolean(b.auto),
    ideas: (b.ideas || []).map((i) => publicIdea(b, i)),
    zipUrl: (b.ideas || []).some((i) => i.file) ? `/api/autopilot/zip/${b.id}` : null,
  });
  const status = () => ({
    settings: data.settings,
    running: Boolean(current),
    phase: current?.phase || null,
    message: current?.message || '',
    lastRun: data.lastRun,
    nextRun: nextRunAt(data),
    batches: data.batches.map(publicBatch),
  });
  const changed = () => onChange({ type: 'autopilot', autopilot: status() });
  const say = (phase, message) => {
    if (!current) return;
    current.phase = phase;
    current.message = message;
    changed();
  };

  async function planBatch(batch, signal) {
    const videos = library.list().filter((a) => a.kind === 'video' && a.status === 'ready');
    if (!videos.length) {
      throw new PipelineError('No videos in your library yet.', { hint: 'Upload or import videos — Autopilot plans from what is in the library.' });
    }
    const unscanned = videos.filter((a) => a.ai?.status !== 'done');
    if (unscanned.length) {
      say('scan', `Claude is watching ${unscanned.length} new video${unscanned.length > 1 ? 's' : ''}…`);
      await scanner.scanNow(unscanned.map((a) => a.id), {
        signal,
        onProgress: (done, total) => say('scan', `Claude is watching your library: ${done}/${total}…`),
      });
    }
    const scanned = library.list().filter((a) => a.kind === 'video' && a.status === 'ready' && a.ai?.status === 'done');
    if (!scanned.length) throw new PipelineError('Claude could not scan any of your videos.', { hint: 'Check the AI scan bar on the Library page.' });
    say('plan', `Claude is planning ${data.settings.perBatch} video${data.settings.perBatch > 1 ? 's' : ''}…`);
    const recent = data.batches
      .flatMap((b) => b.ideas || [])
      .slice(0, 30)
      .map((i) => `${i.title}${i.vibe ? ` (${i.vibe})` : ''}`);
    const prompt = buildPlanPrompt({
      assets: shortlist(scanned, data.settings.direction, 300),
      settings: data.settings,
      count: data.settings.perBatch,
      candidates: Math.min(12, data.settings.perBatch * 2),
      recent,
    });
    const cwd = batchDir(batch);
    await fs.mkdir(cwd, { recursive: true });
    const raw = extractJson(await plan(prompt, { cwd, signal, model: data.settings.plannerModel }));
    const out = normalizePlan(raw, { known: new Set(scanned.map((a) => a.id)), lengths: data.settings.lengths, count: data.settings.perBatch });
    if (!out.ideas.length) throw new PipelineError('Claude did not come up with usable video ideas.', { hint: 'Add a direction in the Autopilot settings, or add more footage.' });
    batch.plan = out.plan;
    batch.ideas = out.ideas;
    await save();
  }

  async function waitForQuiet(signal) {
    for (;;) {
      const busy = otherWork();
      if (!busy) return;
      say('wait', `Waiting until ${busy} finishes…`);
      await new Promise((r) => setTimeout(r, 15_000));
      if (signal.aborted) throw new Error('Cancelled.');
    }
  }

  async function renderBatch(batch, signal) {
    const ideas = batch.ideas;
    for (const [n, idea] of ideas.entries()) {
      if (idea.status === 'done' || idea.status === 'error') continue;
      if (signal.aborted) throw new Error('Cancelled.');
      await waitForQuiet(signal);
      idea.status = 'rendering';
      idea.progress = 0;
      idea.message = 'Starting…';
      say('render', `Making video ${n + 1} of ${ideas.length}: ${idea.title}`);
      await save();
      try {
        const settings = {
          formats: ['9x16'],
          lengths: [idea.length],
          captions: idea.captionStyle,
          accent: idea.accent || undefined,
          music: 'auto',
          brand: data.settings.brand,
          cta: data.settings.cta,
          plannerModel: data.settings.plannerModel,
          voiceover: data.settings.voiceover,
          voice: data.settings.voice,
        };
        let last = 0;
        const r = await renderIdea(idea, {
          prompt: ideaPrompt(idea, data.settings),
          settings,
          signal,
          onJob: (jobId) => {
            idea.jobId = jobId;
            save();
          },
          onProgress: (progress, message) => {
            idea.progress = progress;
            idea.message = message;
            if (Date.now() - last > 1500) {
              last = Date.now();
              changed();
            }
          },
        });
        const base = `${String(n + 1).padStart(2, '0')}-${slugify(idea.title)}`;
        const out = batchDir(batch);
        await fs.mkdir(out, { recursive: true });
        await linkOrCopy(r.file, path.join(out, `${base}.mp4`));
        if (r.poster) await linkOrCopy(r.poster, path.join(out, `${base}.jpg`)).catch(() => null);
        await fs.writeFile(path.join(out, `${base}.txt`), captionText(idea));
        Object.assign(idea, {
          status: 'done',
          file: `${base}.mp4`,
          poster: r.poster ? `${base}.jpg` : null,
          duration: r.duration,
          size: r.size,
          width: r.width,
          height: r.height,
          jobId: r.jobId,
          review: r.review ? { score: r.review.score, summary: r.review.summary } : null,
          progress: 1,
          message: '',
          error: null,
        });
      } catch (err) {
        if (signal.aborted) {
          idea.status = 'queued';
          idea.message = '';
          throw err;
        }
        idea.status = 'error';
        idea.error = { message: err.message || String(err), hint: err.hint || null };
        console.error(`[autopilot] ${idea.title}:`, err.message);
      }
      await save();
      changed();
    }
  }

  async function runBatch(batch) {
    const abort = new AbortController();
    current = { batchId: batch.id, abort, phase: 'start', message: 'Starting…' };
    batch.status = 'running';
    batch.error = null;
    changed();
    try {
      if (!batch.ideas?.length) await planBatch(batch, abort.signal);
      await renderBatch(batch, abort.signal);
      const made = batch.ideas.filter((i) => i.status === 'done').length;
      batch.status = made ? 'done' : 'error';
      if (!made) batch.error = { message: 'None of the videos could be rendered.', hint: batch.ideas.find((i) => i.error)?.error?.message || null };
      if (made) data.lastRun = batch.createdAt;
      else data.failedAt = now();
    } catch (err) {
      const cancelled = abort.signal.aborted;
      batch.status = cancelled ? 'cancelled' : 'error';
      batch.error = cancelled ? { message: 'Cancelled.' } : { message: err.message || String(err), hint: err.hint || null };
      for (const i of batch.ideas || []) if (i.status === 'queued' || i.status === 'rendering') i.status = cancelled ? 'cancelled' : 'error';
      if (!cancelled) {
        data.failedAt = now();
        console.error('[autopilot]', err.message);
      } else if (batch.auto) {
        data.lastRun = batch.createdAt; // a cancelled automatic batch counts — don't start another one straight away
      }
    } finally {
      current = null;
      await save();
      changed();
    }
  }

  function start({ auto = false } = {}) {
    if (current) return null;
    const batch = { id: `b${new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 4)}`, createdAt: now(), status: 'queued', auto, plan: '', ideas: [] };
    data.batches.unshift(batch);
    for (const old of data.batches.splice(MAX_BATCHES)) fs.rm(batchDir(old), { recursive: true, force: true }).catch(() => {});
    save();
    runBatch(batch);
    return batch;
  }

  function tick() {
    if (current) return;
    // Pick up a batch a restart interrupted.
    const unfinished = data.batches.find((b) => b.status === 'running' || b.status === 'queued');
    if (unfinished) {
      runBatch(unfinished);
      return;
    }
    const due = nextRunAt(data);
    if (due != null && now() >= due && !otherWork()) start({ auto: true });
  }

  return {
    status,
    busy: () => Boolean(current),
    start() {
      setTimeout(tick, 20_000).unref?.();
      timer = setInterval(tick, 60_000);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      current?.abort.abort();
    },
    tick,
    runNow() {
      return start({ auto: false });
    },
    cancel() {
      if (!current) return false;
      current.abort.abort();
      return true;
    },
    async setSettings(s) {
      const was = data.settings.enabled;
      data.settings = normalizeSettings(s, data.settings);
      if (data.settings.enabled && !was) data.failedAt = null;
      await save();
      changed();
      if (data.settings.enabled && !was) setTimeout(tick, 1000).unref?.(); // first batch right away when never run
      return status();
    },
    async removeBatch(id) {
      const b = data.batches.find((x) => x.id === id);
      if (!b) return false;
      if (current?.batchId === id) throw new PipelineError('Cancel this batch first.');
      data.batches = data.batches.filter((x) => x !== b);
      await fs.rm(batchDir(b), { recursive: true, force: true });
      await save();
      changed();
      return true;
    },
    /** Absolute path of a finished file in a batch folder, or null. */
    filePath(batchId, name) {
      const b = data.batches.find((x) => x.id === batchId);
      if (!b || !/^[\w.-]+$/.test(name)) return null;
      const known = (b.ideas || []).some((i) => i.file === name || i.poster === name || (i.file && i.file.replace(/\.mp4$/, '.txt') === name));
      return known ? path.join(batchDir(b), name) : null;
    },
    batchFiles(batchId) {
      const b = data.batches.find((x) => x.id === batchId);
      if (!b) return null;
      return (b.ideas || []).filter((i) => i.file).flatMap((i) => [i.file, i.file.replace(/\.mp4$/, '.txt')]).map((f) => path.join(batchDir(b), f));
    },
    settled: () => saving,
  };
}

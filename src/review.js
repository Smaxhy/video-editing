import fs from 'node:fs/promises';
import path from 'node:path';
import { run, round, clamp } from './util.js';
import { callClaude, extractJson } from './editor.js';

/**
 * Self-review: after rendering, Claude watches the finished video the way a creator would — a
 * frame strip (first 3 seconds densely, then the rest) plus hard measurements (loudness, black or
 * frozen frames, length) — and scores it against a short-form rubric. A weak cut can be re-planned
 * once with the reviewer's notes.
 */

/** Times to sample: dense over the hook, then evenly to the end (max 12 frames). */
export function reviewTimes(duration) {
  const t = [0.3, 1, 2, 3];
  const rest = Math.max(0, duration - 3.5);
  const n = Math.min(8, Math.max(2, Math.round(rest / 3)));
  for (let i = 1; i <= n; i++) t.push(3 + (rest * i) / n);
  return t.filter((x) => x < duration - 0.05).map((x) => round(x, 2));
}

/** Loudness / true peak / black / frozen stretches of the rendered file. */
export async function measureVideo(file, { signal } = {}) {
  const r = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-vf', 'blackdetect=d=0.4:pix_th=0.08,freezedetect=n=0.003:d=1.5', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { signal, timeoutMs: 10 * 60_000 });
  const err = r.stderr;
  const num = (re) => {
    const all = [...err.matchAll(re)];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  return {
    lufs: num(/I:\s+(-?[\d.]+) LUFS/g),
    truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/g),
    black: [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [round(Number(m[1])), round(Number(m[2]))]),
    frozen: [...err.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => round(Number(m[1]))),
  };
}

/** One labelled frame strip (time on every tile) for Claude to look at. */
export async function frameStrip(file, out, times, { width, height, signal }) {
  const tileW = 270;
  const tileH = Math.round((tileW * height) / width / 2) * 2;
  const work = `${out}.work`;
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  try {
    for (const [i, t] of times.entries()) {
      await run('ffmpeg', [
        '-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1',
        '-vf', `scale=${tileW}:${tileH},drawbox=x=0:y=0:w=82:h=34:color=black@0.7:t=fill,drawtext=text='${t.toFixed(1)}s':x=8:y=7:fontsize=22:fontcolor=white`,
        path.join(work, `f${String(i).padStart(2, '0')}.jpg`),
      ], { signal, timeoutMs: 60_000 });
    }
    const cols = Math.min(6, times.length);
    const rows = Math.ceil(times.length / cols);
    const r = await run('ffmpeg', [
      '-v', 'error', '-y', '-i', path.join(work, 'f%02d.jpg'), '-vf', `tile=${cols}x${rows}:padding=6:color=white`, '-frames:v', '1', '-q:v', '3', out,
    ], { signal, timeoutMs: 60_000 });
    return r.code === 0 ? out : null;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

export function buildReviewPrompt({ brief, target, duration, measures, image, overlays, captions }) {
  const facts = [
    `length: ${duration.toFixed(1)} s${target ? ` (target ≤ ${target} s)` : ''}`,
    measures.lufs != null ? `loudness: ${measures.lufs} LUFS integrated (target -14), true peak ${measures.truePeak} dBFS` : null,
    measures.black.length ? `black frames at: ${measures.black.map(([a, b]) => `${a}-${b}s`).join(', ')}` : 'no black frames',
    measures.frozen.length ? `frozen picture at: ${measures.frozen.map((t) => `${t}s`).join(', ')}` : 'no frozen picture',
    `on-screen text: ${overlays.length ? overlays.map((o) => `${o.type} "${o.text}" ${o.start}-${o.end}s`).join('; ') : 'none'}`,
    `burned-in captions: ${captions}`,
  ].filter(Boolean);
  return `You are a strict short-form video editor reviewing a finished vertical video before it is posted to Reels/TikTok.
Open the frame strip ${image} with the Read tool — tiles are labelled with their time; the first four cover the hook (0.3/1/2/3 s).

## The brief
"""
${brief}
"""

## Measurements
${facts.map((f) => `- ${f}`).join('\n')}

## Score it (1-10 each, be honest — 8+ means ready to post)
- hook: do the first 2 seconds stop the scroll (motion, a face, bold text, a question)?
- clarity: is all text readable, inside the frame, not covered by the platform UI (bottom ~25% and right edge), not overlapping other text?
- visuals: sharp, well exposed, relevant shots, no black/frozen/awkward frames?
- pacing: does it keep moving, no dead stretches, ends strong?
- brief: does it deliver what was asked?

Reply with ONLY this JSON:
{"score": 1-10 overall, "hook": n, "clarity": n, "visuals": n, "pacing": n, "brief": n,
 "summary": "one sentence verdict",
 "issues": ["specific problem with timestamp", "..."],
 "fixes": "concrete instructions for the editor to fix the issues in a re-edit (which moment to open on, what to cut, what text to change) — empty if score >= 8"}`;
}

export function normalizeReview(raw) {
  const n = (v) => clamp(Math.round(Number(v) || 0), 1, 10);
  return {
    score: n(raw.score),
    hook: n(raw.hook),
    clarity: n(raw.clarity),
    visuals: n(raw.visuals),
    pacing: n(raw.pacing),
    brief: n(raw.brief),
    summary: String(raw.summary || '').slice(0, 300),
    issues: (Array.isArray(raw.issues) ? raw.issues : []).map((s) => String(s).slice(0, 200)).slice(0, 6),
    fixes: String(raw.fixes || '').slice(0, 1500),
  };
}

/** Review one rendered variant. Returns the normalized review plus the measurements. */
export async function reviewVideo({ file, workDir, brief, target, duration, width, height, overlays, captions, model, signal }) {
  await fs.mkdir(workDir, { recursive: true });
  const measures = await measureVideo(file, { signal });
  const image = 'review.jpg';
  const strip = await frameStrip(file, path.join(workDir, image), reviewTimes(duration), { width, height, signal });
  if (!strip) throw new Error('could not grab frames from the video');
  const prompt = buildReviewPrompt({ brief, target, duration, measures, image, overlays, captions });
  const raw = extractJson(await callClaude(prompt, { cwd: workDir, signal, tools: 'Read', model }));
  return { ...normalizeReview(raw), measures };
}

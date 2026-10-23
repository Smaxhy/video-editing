import { decodeMono, analyzeBeats } from './beats.js';
import { round, clamp } from './util.js';

/**
 * "Listening" to a music track so Claude can match it to a video: tempo, how energetic it is, the
 * energy over time, the drop (the biggest lift in the track) and its loud sections. All plain JS on
 * the decoded samples — no models. CLAP genre/mood tags are added separately by the AI index.
 */

export const MUSIC_VERSION = 1;
const SR = 22050;
const WIN = 0.5; // seconds per loudness window

/** RMS loudness per window, in dBFS. */
export function loudness(samples, win = WIN) {
  const n = Math.round(win * SR);
  const out = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += samples[j] * samples[j];
    out.push(10 * Math.log10(s / n + 1e-10));
  }
  return out;
}

/** Centered moving average over `w` items. */
function movingAverage(a, w) {
  const h = Math.floor(w / 2);
  return a.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(a.length - 1, i + h); j++, c++) s += a[j];
    return s / c;
  });
}

/**
 * Musical summary from per-window loudness (dBFS) and the beat analysis. Exported for tests.
 * energy curve: 0..1 relative to the track's own loud parts (a quiet intro reads low even in EDM).
 */
export function summarize(db, { bpm, beats = [], downbeats = [] }, win = WIN) {
  const duration = db.length * win;
  if (db.length < 8) return null;
  const sorted = [...db].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.95)];
  const floor = Math.max(sorted[Math.floor(sorted.length * 0.05)], top - 30);
  // 2 s smoothing: a section's level, not single hits.
  const level = movingAverage(db.map((d) => clamp((d - floor) / Math.max(6, top - floor), 0, 1)), Math.round(2 / win));
  const avg = (a, b) => {
    const s = level.slice(Math.max(0, a), Math.max(Math.max(0, a) + 1, b));
    return s.reduce((x, y) => x + y, 0) / s.length;
  };

  // Drop: the moment with the largest lift between the 4 s before and the 6 s after, landing in a
  // loud part. Snapped to the nearest downbeat so a cut there hits the downbeat.
  const k4 = Math.round(4 / win);
  const k6 = Math.round(6 / win);
  let drop = null;
  let best = 0.18; // smaller lifts are not a drop
  for (let i = Math.round(3 / win); i < level.length - Math.round(3 / win); i++) {
    const after = avg(i, i + k6);
    const lift = after - avg(i - k4, i);
    if (after >= 0.6 && lift > best) {
      best = lift;
      drop = i * win;
    }
  }
  // Refine onto the beat with the sharpest jump in raw loudness (the drop hits on a beat, usually
  // the downbeat — preferred when it is as sharp as any other beat).
  if (drop != null) {
    const mean = (a, b) => {
      const s = db.slice(Math.max(0, Math.round(a / win)), Math.max(Math.round(a / win) + 1, Math.round(b / win)));
      return s.reduce((x, y) => x + y, 0) / s.length;
    };
    const near = (beats.length ? beats : downbeats).filter((b) => Math.abs(b - drop) <= 2 && b >= 1);
    let sharpest = -Infinity;
    for (const b of near) {
      const jump = mean(b, b + 1) - mean(b - 1, b) + (downbeats.includes(b) ? 0.5 : 0);
      if (jump > sharpest) {
        sharpest = jump;
        drop = b;
      }
    }
  }

  // Loud sections: stretches ≥ 4 s at ≥ 70% of the track's peak level.
  const loud = [];
  let from = null;
  level.forEach((v, i) => {
    if (v >= 0.7 && from == null) from = i;
    if ((v < 0.7 || i === level.length - 1) && from != null) {
      const to = v < 0.7 ? i : i + 1;
      if ((to - from) * win >= 4) loud.push([round(from * win, 1), round(to * win, 1)]);
      from = null;
    }
  });
  const intro = level.findIndex((v) => v >= 0.6);

  // Overall energy: tempo + how much of the track is loud + how hard it is mastered.
  const loudShare = level.filter((v) => v >= 0.7).length / level.length;
  const tempo = bpm ? clamp((bpm - 70) / 80, 0, 1) : 0.4;
  const master = clamp((top + 24) / 14, 0, 1); // RMS of a loud modern master ≈ -10 dBFS
  const score = round(0.4 * tempo + 0.35 * loudShare + 0.25 * master, 2);
  const energy = score >= 0.6 ? 'high' : score >= 0.38 ? 'medium' : 'low';

  // 12-step curve, one digit (0-9) per step — readable for Claude at a glance.
  const steps = 12;
  const step = duration / steps;
  const curve = Array.from({ length: steps }, (_, s) => Math.min(9, Math.round(avg(Math.round((s * step) / win), Math.round(((s + 1) * step) / win)) * 9))).join('');

  return {
    v: MUSIC_VERSION,
    bpm: bpm ? Math.round(bpm) : null,
    energy,
    score,
    drop: drop == null ? null : round(drop, 2),
    intro: intro > 0 ? round(intro * win, 1) : 0,
    loud: loud.slice(0, 5),
    curve,
    curveStep: round(step, 1),
  };
}

/** Scan a music file (first 10 minutes). */
export async function scanMusic(file) {
  const samples = await decodeMono(file, 600);
  const beats = analyzeBeats(samples);
  return summarize(loudness(samples), beats);
}

/** One-line description of a scanned track for the planner. */
export function musicLine(m, tags) {
  if (!m && !tags) return '';
  const parts = [];
  if (m?.bpm) parts.push(`${m.bpm} BPM`);
  if (m?.energy) parts.push(`${m.energy} energy`);
  if (tags?.genres?.length) parts.push(`genre: ${tags.genres.join(' / ')}`);
  if (tags?.moods?.length) parts.push(`mood: ${tags.moods.join(', ')}`);
  if (m?.drop != null) parts.push(`drop at ${m.drop}s`);
  if (m?.intro) parts.push(`quiet intro ${m.intro}s`);
  if (m?.loud?.length) parts.push(`loud parts ${m.loud.map(([a, b]) => `${a}-${b}s`).join(', ')}`);
  if (m?.curve) parts.push(`energy curve ${m.curve} (one digit per ${m.curveStep}s, 0 quiet … 9 loudest)`);
  return parts.join(' · ');
}

/**
 * Where the music should start in a version: when the track has a drop and the plan marks its peak
 * (OUTPUT seconds), start so the drop hits the peak — if enough track remains after that start.
 */
export function alignedStart({ drop, duration }, { peak, length, fallback = 0 }) {
  if (drop == null || !Number.isFinite(peak)) return fallback;
  const start = drop - peak;
  if (start < 0 || start + length > duration + 0.5) return fallback;
  return round(start, 3);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { round, exists } from './util.js';

/**
 * Beat tracking for music tracks, in plain JavaScript (no Python, no models):
 *   1. onset strength = positive spectral flux of the log-magnitude spectrum (hop ≈ 23 ms),
 *   2. tempo = autocorrelation of the onset envelope with a prior around 120 BPM,
 *   3. beats = Ellis' dynamic-programming beat tracker (the method behind librosa.beat),
 *   4. downbeats = the beat phase (of 4) with the strongest low-frequency onsets.
 * Results are cached next to the track.
 */

const SR = 22050;
const N = 1024;
const HOP = 512;
const FPS = SR / HOP;
const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Decode a file to mono 22.05 kHz float samples (at most `maxSeconds`). */
export function decodeMono(file, maxSeconds = 600) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-t', String(maxSeconds), '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('could not decode audio'));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/** In-place radix-2 FFT (re, im of length N). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Onset strength envelopes: { all, low } (low = bins under ~200 Hz, for kick drums / downbeats). */
export function onsetEnvelope(samples) {
  const frames = Math.max(0, Math.floor((samples.length - N) / HOP) + 1);
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const bins = N / 2;
  const lowBins = Math.round((200 / SR) * N);
  let prev = new Float32Array(bins);
  const all = new Float32Array(frames);
  const low = new Float32Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(bins);
    let a = 0;
    let l = 0;
    for (let k = 1; k < bins; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) {
        a += d;
        if (k <= lowBins) l += d;
      }
    }
    all[f] = a;
    low[f] = l;
    prev = mag;
  }
  // Remove the slowly varying part (local mean) and normalise.
  const detrend = (env) => {
    const out = new Float32Array(env.length);
    const W = Math.round(FPS); // ±1 s
    let max = 1e-9;
    for (let i = 0; i < env.length; i++) {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - W); j < Math.min(env.length, i + W); j += 4) {
        s += env[j];
        c++;
      }
      out[i] = Math.max(0, env[i] - s / c);
      max = Math.max(max, out[i]);
    }
    for (let i = 0; i < out.length; i++) out[i] /= max;
    return out;
  };
  return { all: detrend(all), low: detrend(low) };
}

/** Tempo period in onset frames (60–200 BPM, log-normal prior centred on 120 BPM). */
export function estimatePeriod(env) {
  const minLag = Math.round((60 / 200) * FPS);
  const maxLag = Math.round((60 / 60) * FPS);
  const ac = (lag) => {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    return s / (env.length - lag);
  };
  let best = Math.round((60 / 120) * FPS);
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = ac(lag) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Sub-frame refinement (parabola through the peak) — an integer lag drifts over a long track.
  const [a, b, c] = [ac(best - 1), ac(best), ac(best + 1)];
  const denom = a - 2 * b + c;
  return denom < 0 ? best + clampNum((0.5 * (a - c)) / denom, -0.5, 0.5) : best;
}

/** Ellis' DP beat tracker: beat frame indices. */
export function trackBeats(env, period, tightness = 100) {
  const n = env.length;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let p = t - Math.round(2 * period); p <= t - Math.round(period / 2); p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (v > best || arg === -1) {
        best = v;
        arg = p;
      }
    }
    score[t] = env[t] + (arg === -1 ? 0 : best);
    back[t] = arg;
  }
  // Start from the best-scoring frame in the last period and walk back.
  let t = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[t]) t = i;
  const beats = [];
  while (t >= 0) {
    beats.push(t);
    t = back[t];
  }
  return beats.reverse();
}

/** Small smoothing so sharp onsets that fall between frames still line up at fractional lags. */
function smooth(env) {
  const k = [0.25, 0.6, 1, 0.6, 0.25];
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += (env[i + j] || 0) * k[j + 2];
    out[i] = s / 2.7;
  }
  return out;
}

/** { bpm, beats: [s], downbeats: [s] } for a decoded track. */
export function analyzeBeats(samples) {
  const raw = onsetEnvelope(samples);
  const all = smooth(raw.all);
  const low = smooth(raw.low);
  if (all.length < FPS * 4) return { bpm: null, beats: [], downbeats: [] };
  // Beats usually carry the kick drum: weight the low band so the grid doesn't slide onto hi-hats.
  const track = all.map((v, i) => 0.5 * v + low[i]);
  const period = estimatePeriod(track);
  const frames = trackBeats(track, period);
  let phase = 0;
  let bestEnergy = -1;
  for (let k = 0; k < 4; k++) {
    let e = 0;
    for (let i = k; i < frames.length; i += 4) e += low[frames[i]] + 0.5 * all[frames[i]];
    if (e > bestEnergy) {
      bestEnergy = e;
      phase = k;
    }
  }
  const secs = frames.map((f) => round((f * HOP + N / 2) / SR, 3));
  return {
    bpm: round((60 * FPS) / period, 1),
    beats: secs,
    downbeats: secs.filter((_, i) => i % 4 === phase),
  };
}

/** Cached beat analysis of a music file. */
export async function beatsFor(file, cacheFile) {
  if (cacheFile && (await exists(cacheFile))) return JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  const result = analyzeBeats(await decodeMono(file));
  if (cacheFile) {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(result));
  }
  return result;
}

/**
 * Move cuts onto the music: the end of every non-talking scene (B-roll, POV, montage) is nudged to
 * the nearest downbeat within 0.35 s (or beat within 0.22 s) by trimming/extending that scene.
 * Talking scenes keep their word-accurate cuts. Overlays follow their scenes proportionally.
 * beats/downbeats are in OUTPUT seconds; clipDuration(id) bounds extensions.
 */
export function snapCutsToBeats(plan, { beats, downbeats }, { talking, clipDuration, layout }) {
  if (!beats?.length || plan.scenes.length < 2) return { plan, moved: 0 };
  const scenes = plan.scenes.map((s) => ({ ...s }));
  const nearest = (list, t, tol) => {
    let best = null;
    for (const b of list) if (Math.abs(b - t) <= tol && (best == null || Math.abs(b - t) < Math.abs(best - t))) best = b;
    return best;
  };
  let moved = 0;
  for (let i = 0; i < scenes.length - 1; i++) {
    if (talking(scenes[i]) || scenes[i + 1].transition !== 'cut') continue;
    const lay = layout({ ...plan, scenes });
    const sc = lay.scenes[i];
    const cut = sc.tlStart + sc.duration;
    const target = nearest(downbeats, cut, 0.35) ?? nearest(beats, cut, 0.22);
    if (target == null || Math.abs(target - cut) < 0.01) continue;
    const end = round(scenes[i].end + (target - cut) * scenes[i].speed, 3);
    if (end - scenes[i].start < 0.5 || end > clipDuration(scenes[i].clip) - 0.02) continue;
    scenes[i].end = end;
    moved++;
  }
  if (!moved) return { plan, moved };
  const before = layout(plan);
  const after = layout({ ...plan, scenes });
  const remap = (t) => {
    const i = Math.max(0, before.scenes.findIndex((s) => t < s.tlStart + s.duration));
    const a = before.scenes[i] || before.scenes[before.scenes.length - 1];
    const b = after.scenes[a.index];
    return b.tlStart + ((t - a.tlStart) / (a.duration || 1)) * b.duration;
  };
  const overlays = plan.overlays.map((o) => {
    if (o.type === 'cta' && o.end >= before.total - 0.1) {
      const len = o.end - o.start;
      return { ...o, start: round(Math.max(0, after.total - len), 3), end: round(after.total, 3) };
    }
    const start = round(remap(o.start), 3);
    return { ...o, start, end: round(Math.min(after.total, Math.max(remap(o.end), start + 0.4)), 3) };
  });
  return { plan: { ...plan, scenes, overlays }, moved };
}

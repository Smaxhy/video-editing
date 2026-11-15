import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { round, exists } from './util.js';

/**
 * Precision pass — what separates a hand-made edit from an automatic one is where exactly the cuts
 * sit. After the plan is final, every cut is placed the way an editor would nudge it on a timeline:
 *
 *   1. Speech cuts go in the quiet gap between words, found in the clip's real loudness curve (the
 *      transcriber's word times are only good to ±80 ms): no clipped first syllable, no chopped tail,
 *      no click.
 *   2. Cuts never land inside a word.
 *   3. B-roll cuts next to a camera cut move onto it, so no 2-frame flash of the neighbouring shot.
 *   4. Everything is put on the frame grid: each shot lasts a whole number of output frames, so cuts
 *      stay exactly where they were placed (on the word, on the beat) all the way through.
 */
export const FPS = 30;
const HOP = 0.01; // envelope resolution: 10 ms
const SR = 16000;

/** Loudness curve of a clip's sound: dBFS per 10 ms (Int8, −100…0). Cached next to the clip. */
export async function loudnessCurve(file, cacheFile, { maxSeconds = 1800 } = {}) {
  if (cacheFile && (await exists(cacheFile))) return new Int8Array(await fs.readFile(cacheFile));
  const pcm = await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-t', String(maxSeconds), '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('could not decode audio'));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.length / 4) * 4)));
    });
  });
  const curve = envelope(pcm, SR);
  if (cacheFile) {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, Buffer.from(curve.buffer));
  }
  return curve;
}

/** RMS level per 10 ms window, in dBFS (clamped to −100…0). Exported for tests. */
export function envelope(samples, sr = SR) {
  const win = Math.round(sr * HOP);
  const out = new Int8Array(Math.floor(samples.length / win));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let k = i * win; k < (i + 1) * win; k++) sum += samples[k] * samples[k];
    const db = 10 * Math.log10(sum / win + 1e-10);
    out[i] = Math.max(-100, Math.min(0, Math.round(db)));
  }
  return out;
}

const at = (curve, t) => curve[Math.max(0, Math.min(curve.length - 1, Math.round(t / HOP)))];

/**
 * Where the speech really starts near `guess` (a word's transcribed start): the first moment the
 * level rises clearly above the quiet floor of [from, to]. Returns null when the window has no
 * clear quiet-then-loud shape (music under the voice, constant noise) — then the guess stands.
 */
export function onsetNear(curve, guess, from, to) {
  const a = Math.max(0, Math.floor(from / HOP));
  const b = Math.min(curve.length - 1, Math.ceil(to / HOP));
  if (b - a < 4) return null;
  let floor = 0;
  let peak = -100;
  for (let i = a; i <= b; i++) {
    if (curve[i] < floor) floor = curve[i];
    if (curve[i] > peak) peak = curve[i];
  }
  if (peak - floor < 12) return null; // no real gap to cut in
  const gate = floor + Math.max(8, (peak - floor) * 0.4);
  // Walk back from the guess to the last quiet frame before it.
  let i = Math.min(b, Math.round((guess + 0.06) / HOP));
  while (i > a && curve[i] >= gate) i--;
  if (curve[i] >= gate) return null; // loud all the way back: the gap isn't in this window
  // …then forward to where it becomes loud again: that's the onset.
  while (i < b && curve[i] < gate) i++;
  if (curve[i] < gate) return null; // never gets loud in this window
  return round(i * HOP, 3);
}

/** Where the speech really ends near `guess` (a word's transcribed end): mirror of onsetNear. */
export function offsetNear(curve, guess, from, to) {
  const a = Math.max(0, Math.floor(from / HOP));
  const b = Math.min(curve.length - 1, Math.ceil(to / HOP));
  if (b - a < 4) return null;
  let floor = 0;
  let peak = -100;
  for (let i = a; i <= b; i++) {
    if (curve[i] < floor) floor = curve[i];
    if (curve[i] > peak) peak = curve[i];
  }
  if (peak - floor < 12) return null;
  const gate = floor + Math.max(8, (peak - floor) * 0.4);
  let i = Math.max(a, Math.round((guess - 0.06) / HOP));
  while (i < b && curve[i] >= gate) i++;
  if (curve[i] >= gate) return null;
  while (i > a && curve[i] < gate) i--;
  if (curve[i] < gate) return null;
  return round((i + 1) * HOP, 3);
}

const PRE_ROLL = 0.06; // breath before the first syllable
const TAIL = 0.14; // let the last syllable ring out
const SEARCH = 0.35;

/**
 * Put the in/out point of every talking scene in the quiet gap around its first/last word.
 * words(clip) → [{ word, start, end }], curve(clip) → Int8Array | null, clipDuration(clip) → seconds.
 * Returns { plan, moved } (moved = cut points changed by ≥ 1 frame).
 */
export function refineSpeechCuts(plan, { words, curve, clipDuration, talking }) {
  let moved = 0;
  const scenes = plan.scenes.map((s) => {
    if (s.speed !== 1 || !talking(s)) return s;
    const all = words(s.clip) || [];
    // Words that are mostly inside the scene belong to it.
    const mine = all.filter((w) => Math.min(w.end, s.end) - Math.max(w.start, s.start) > (w.end - w.start) * 0.5);
    if (!mine.length) return s;
    const first = mine[0];
    const last = mine[mine.length - 1];
    const prev = all[all.indexOf(first) - 1];
    const next = all[all.indexOf(last) + 1];
    const c = curve(s.clip);
    let { start, end } = s;

    // IN: never earlier than the previous word's end (don't let its tail leak in), never inside the first word.
    const earliest = Math.max(0, prev ? prev.end + 0.01 : 0, first.start - SEARCH);
    const onset = c ? onsetNear(c, first.start, earliest, first.start + 0.12) : null;
    const speechStart = onset ?? first.start;
    const wantIn = Math.max(earliest, speechStart - PRE_ROLL);
    // Only tighten or protect: keep a deliberate long lead-in the planner left (a pause for effect).
    if (start > wantIn || speechStart - start < 0.5) start = wantIn;

    // OUT: never past the next word's start, never inside the last word.
    const latest = Math.min(clipDuration(s.clip) || Infinity, next ? next.start - 0.01 : Infinity, last.end + SEARCH + 0.1);
    const offset = c ? offsetNear(c, last.end, last.end - 0.12, latest) : null;
    const speechEnd = offset ?? last.end;
    const wantOut = Math.min(latest, speechEnd + TAIL);
    if (end < wantOut || end - speechEnd < 0.6) end = wantOut;

    if (end - start < 0.2) return s;
    if (Math.abs(start - s.start) >= 1 / FPS || Math.abs(end - s.end) >= 1 / FPS) moved++;
    return { ...s, start: round(start, 3), end: round(end, 3) };
  });
  return { plan: { ...plan, scenes }, moved };
}

/**
 * B-roll / montage scenes whose in or out point sits a few frames away from a camera cut in the
 * source get moved onto it — otherwise the shot opens or closes with a flash of another shot.
 * shots(clip) → [seconds of each camera cut].
 */
export function snapToShotChanges(plan, { shots, talking, tolerance = 0.2 }) {
  let moved = 0;
  const scenes = plan.scenes.map((s) => {
    const cuts = shots(s.clip);
    if (!cuts?.length || talking(s) || s.ramp) return s;
    let { start, end } = s;
    // A camera cut just after the in point: start on it.
    const afterIn = cuts.find((t) => t > start && t - start <= tolerance);
    if (afterIn != null) start = afterIn;
    // A camera cut just before the out point: end on it.
    const beforeOut = [...cuts].reverse().find((t) => t < end && end - t <= tolerance);
    if (beforeOut != null) end = beforeOut;
    // In point a hair before a camera cut that the shot then runs through is fine; one a hair
    // *before* its own start (the shot begins 1-2 frames after a cut) is already clean.
    if (end - start < 0.25 || (start === s.start && end === s.end)) return s;
    moved++;
    return { ...s, start: round(start, 3), end: round(end, 3) };
  });
  return { plan: { ...plan, scenes }, moved };
}

/**
 * Put the whole edit on the frame grid. Each scene's in point snaps to a frame and its length on
 * screen becomes a whole number of frames; transitions and text times snap too. Without this,
 * fractions of a frame pile up and every later cut drifts off the word / beat it was placed on.
 * Returns { plan, dropped } (scenes shorter than 4 frames are removed — they only read as glitches).
 */
export function quantizePlan(plan, { fps = FPS, clipDuration = () => Infinity } = {}) {
  const f = (t) => Math.round(t * fps) / fps;
  let dropped = 0;
  let carry = 0; // rounding error handed to the next shot, so cut positions never drift by more than half a frame
  const scenes = [];
  for (const s of plan.scenes) {
    const ideal = (s.end - s.start) / s.speed + carry;
    const frames = Math.round(ideal * fps);
    if (frames < 4 && !s.ramp) {
      dropped++;
      continue;
    }
    carry = ideal - Math.max(frames, 1) / fps;
    let start = f(s.start);
    let end = start + (Math.max(frames, 1) / fps) * s.speed;
    const max = clipDuration(s.clip) || Infinity;
    if (end > max) {
      // Shift the window back rather than shortening the shot (keeps it on the beat).
      start = Math.max(0, f(start - (end - max)));
      end = Math.min(max, start + (Math.max(frames, 1) / fps) * s.speed);
    }
    scenes.push({ ...s, start: round(start, 4), end: round(end, 4), transitionDuration: s.transitionDuration ? round(f(s.transitionDuration), 4) : s.transitionDuration });
  }
  const overlays = (plan.overlays || []).map((o) => ({ ...o, start: round(f(o.start), 4), end: round(f(o.end), 4) }));
  return { plan: { ...plan, scenes: scenes.length ? scenes : plan.scenes, overlays }, dropped: scenes.length ? dropped : 0 };
}

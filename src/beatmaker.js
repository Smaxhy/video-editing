import fs from 'node:fs/promises';
import path from 'node:path';
import { run, tail, round, PipelineError } from './util.js';

/**
 * ClipForge's own music, synthesised in plain JS (instant, no model, no licence): a produced-sounding
 * instrumental in the style the vibe calls for — lo-fi, pop/house, trap or cinematic — arranged AROUND
 * THE EDIT: a filtered intro, a riser + drum fill into the drop, and the drop exactly on the video's
 * peak. FFmpeg adds stereo width, a room reverb and streaming loudness. It is the last link in the
 * music chain (library track → MusicGen → this), so no video ever goes out silent.
 */
const SR = 44100;

export const PRESETS = {
  lofi: { bpm: 86, swing: 0.6, scale: 'major', prog: [[0, 4, 7, 11], [9, 12, 16, 19], [2, 5, 9, 12], [7, 11, 14, 17]], pattern: 'lofi', root: 57 },
  house: { bpm: 118, swing: 0.5, scale: 'minor', prog: [[0, 3, 7, 10], [8, 12, 15, 19], [3, 7, 10, 14], [10, 14, 17, 21]], pattern: 'house', root: 57 },
  trap: { bpm: 142, swing: 0.5, scale: 'minor', prog: [[0, 3, 7, 12], [8, 12, 15, 20], [5, 8, 12, 17], [7, 10, 14, 19]], pattern: 'trap', root: 53 },
  quirky: { bpm: 112, swing: 0.56, scale: 'major', prog: [[0, 4, 7, 12], [5, 9, 12, 17], [7, 11, 14, 19], [0, 4, 7, 12]], pattern: 'quirky', root: 60 },
  cinematic: { bpm: 92, swing: 0.5, scale: 'minor', prog: [[0, 7, 12, 15], [8, 15, 20, 24], [3, 10, 15, 19], [10, 17, 22, 26]], pattern: 'cinematic', root: 50 },
};

/** Which preset fits the planner's sound idea. Exported for tests. */
export function pickPreset(sound = {}) {
  const t = `${sound?.style || ''} ${sound?.vibe || ''} ${sound?.prompt || ''}`.toLowerCase();
  if (/cinematic|epic|orchestr|emotional|sad|piano|inspir|motivat|documentary|trailer/.test(t)) return 'cinematic';
  if (/trap|drill|phonk|hype|aggress|rap|hip ?hop|808|gym|sport|intense/.test(t)) return 'trap';
  if (/quirky|funny|comed|meme|playful|silly|goofy|cartoon|pizzicato|mischiev/.test(t)) return 'quirky';
  if (/house|edm|dance|pop|upbeat|happy|energetic|funk|disco|summer|fun/.test(t)) return 'house';
  if (/lo-?fi|chill|calm|relax|cozy|cosy|satisf|soft|acoustic|ambient|study|aesthetic/.test(t)) return 'lofi';
  return sound?.energy === 'high' ? 'trap' : sound?.energy === 'low' ? 'lofi' : 'house';
}

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const hash = (str) => [...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Add a voice into the buffer: fn(t, i) for `len` seconds from `at`. */
function add(buf, at, len, fn) {
  const a = Math.max(0, Math.round(at * SR));
  const b = Math.min(buf.length, Math.round((at + len) * SR));
  for (let i = a; i < b; i++) buf[i] += fn((i - a) / SR, i);
}
const env = (t, attack, decay) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

function kick(buf, at, gain = 1, long = false) {
  let ph = 0;
  add(buf, at, long ? 1.1 : 0.45, (t) => {
    const f = (long ? 42 : 50) + 120 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    const click = t < 0.004 ? (1 - t / 0.004) * 0.5 : 0;
    return gain * (Math.tanh(1.6 * Math.sin(ph)) * env(t, 0.002, long ? 0.45 : 0.16) + click);
  });
}
function snare(buf, at, gain, r, clap = false) {
  let lp = 0;
  add(buf, at, 0.35, (t) => {
    lp += 0.35 * (r() * 2 - 1 - lp); // darker noise: body, not hiss
    const noise = lp * 1.6;
    const body = Math.sin(2 * Math.PI * 190 * t) * env(t, 0.001, 0.05);
    const claps = clap ? (t < 0.03 ? 0.6 + 0.4 * Math.sin(t * 900) : 1) : 1;
    return gain * (0.75 * noise * env(t, 0.001, clap ? 0.09 : 0.12) * claps + 0.4 * body);
  });
}
function hat(buf, at, gain, r, open = false) {
  let prev = 0;
  add(buf, at, open ? 0.3 : 0.06, (t) => {
    const n = r() * 2 - 1;
    const hp = n - prev; // crude high-pass: keeps the sizzle
    prev = n;
    return gain * 0.16 * hp * env(t, 0.0005, open ? 0.1 : 0.015);
  });
}
/** Warm poly voice: detuned saws through a one-pole low-pass (`bright` 0..1) with an AR envelope. */
function chord(buf, at, len, notes, { gain = 0.12, bright = 0.3, attack = 0.02, release = 0.3, kind = 'saw' } = {}) {
  const lpA = 0.02 + bright * 0.25;
  const voices = notes.flatMap((m) => [mtof(m) * 0.997, mtof(m) * 1.003]);
  const phases = voices.map(() => Math.random());
  let lp = 0;
  add(buf, at, len + release, (t) => {
    let s = 0;
    for (let v = 0; v < voices.length; v++) {
      phases[v] = (phases[v] + voices[v] / SR) % 1;
      s += kind === 'saw' ? 2 * phases[v] - 1 : Math.sin(2 * Math.PI * phases[v]) + 0.25 * Math.sin(4 * Math.PI * phases[v]);
    }
    lp += lpA * (s / voices.length - lp);
    const e = t < attack ? t / attack : t < len ? 1 : Math.exp(-(t - len) / (release / 3));
    return gain * lp * e * (kind === 'saw' ? 2.2 : 1);
  });
}
function bass(buf, at, len, note, { gain = 0.35, glideFrom = null, sub = false } = {}) {
  let ph = 0;
  add(buf, at, len, (t) => {
    const m = glideFrom != null && t < 0.08 ? glideFrom + (note - glideFrom) * (t / 0.08) : note;
    ph += (2 * Math.PI * mtof(m)) / SR;
    const tone = sub ? Math.sin(ph) : Math.tanh(1.8 * Math.sin(ph) + 0.3 * Math.sin(2 * ph));
    return 0.7 * gain * tone * Math.min(1, t / 0.005) * Math.min(1, (len - t) / 0.02);
  });
}
function riser(buf, at, len, r) {
  let lp = 0;
  add(buf, at, len, (t) => {
    const p = t / len;
    lp += (0.01 + 0.5 * p * p) * (r() * 2 - 1 - lp);
    return 0.35 * p * p * lp + 0.08 * p * Math.sin(2 * Math.PI * (200 + 900 * p) * t);
  });
}
function crash(buf, at, r) {
  let lp = 0;
  add(buf, at, 2.2, (t) => {
    lp += 0.5 * (r() * 2 - 1 - lp);
    return 0.16 * lp * env(t, 0.001, 0.6);
  });
}

/**
 * Render the arrangement: `seconds` long, the drop at `drop` (snapped to a bar). Returns
 * { samples, bpm, beats, downbeats, drop } (seconds). Exported for tests.
 */
export function composeBeat({ preset = 'house', seconds = 30, drop = null, seed = 1 }) {
  const P = PRESETS[preset] || PRESETS.house;
  const r = rng(seed);
  const bpm = P.bpm + Math.round((r() - 0.5) * 6);
  const beat = 60 / bpm;
  const bar = beat * 4;
  const root = P.root + Math.floor(r() * 5) - 2;
  const bars = Math.ceil((seconds + 1) / bar);
  // The drop on the first bar line at/after the requested time (the music start then shifts it onto
  // the peak exactly), at least one bar in so there is an intro to build from.
  const dropBar = drop == null ? Math.min(bars - 1, Math.max(1, Math.round((seconds * 0.3) / bar))) : Math.max(1, Math.ceil(drop / bar - 0.02));
  const buf = new Float32Array(Math.ceil((bars * bar + 2.5) * SR));
  const swing = (k) => (k % 2 ? (P.swing - 0.5) * beat : 0); // delays every 2nd 8th note

  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const full = b >= dropBar;
    const prog = P.prog[b % P.prog.length];
    const notes = prog.map((n) => root + n);
    const lastBefore = b === dropBar - 1;
    const ig = (full ? 1 : 0.55) * (P.pattern === 'trap' ? 2.6 : 4.2); // harmony level; the intro sits back so the drop lands
    // Harmony: always there (the intro is just the chords, darker).
    if (P.pattern === 'lofi') chord(buf, t0, bar * 0.98, notes, { gain: ig * (0.1), bright: full ? 0.22 : 0.12, kind: 'sine', attack: 0.01, release: 0.6 });
    else if (P.pattern === 'cinematic') chord(buf, t0, bar, [...notes, notes[0] - 12], { gain: ig * (0.1), bright: full ? 0.35 : 0.15, attack: 0.6, release: 1.2 });
    else if (P.pattern === 'trap') {
      // Dark bell plucks on the 8ths.
      for (let k = 0; k < 8; k++) chord(buf, t0 + k * beat / 2, beat * 0.3, [notes[(k * 3) % 4] + 12], { gain: ig * (0.08), bright: 0.5, kind: 'sine', attack: 0.002, release: 0.25 });
      chord(buf, t0, bar, notes, { gain: ig * (full ? 0.05 : 0.07), bright: 0.12, attack: 0.3, release: 0.8 });
    } else if (P.pattern === 'quirky') {
      // Pizzicato-style staccato arpeggio, bouncing up and down the chord.
      const arp = [0, 1, 2, 3, 2, 1, 2, 3];
      for (let k = 0; k < 8; k++) chord(buf, t0 + k * beat / 2 + swing(k), beat * 0.12, [notes[arp[k]] + 12], { gain: ig * 0.06, bright: 0.6, kind: 'sine', attack: 0.002, release: 0.12 });
    } else {
      // House: off-beat chord stabs (pumping), pad underneath.
      for (let k = 0; k < 4; k++) chord(buf, t0 + k * beat + beat / 2, beat * 0.35, notes, { gain: ig * (full ? 0.09 : 0.06), bright: full ? 0.45 : 0.18, attack: 0.005, release: 0.12 });
    }
    if (lastBefore) {
      riser(buf, t0, bar, r);
      // Drum fill: 16th-note snares building up.
      for (let k = 0; k < 8; k++) snare(buf, t0 + bar / 2 + (k * bar) / 16, 0.12 + k * 0.04, r);
    }
    if (b === dropBar) crash(buf, t0, r);
    // Intro: light hats only (and a kick on 1 for house / lofi so the tempo reads).
    if (!full) {
      if (!lastBefore) for (let k = 0; k < 8; k++) hat(buf, t0 + k * beat / 2 + swing(k), k % 2 ? 0.25 : 0.4, r);
      continue;
    }
    switch (P.pattern) {
      case 'lofi':
        [0, 2.5].forEach((q) => kick(buf, t0 + q * beat, 0.8));
        [1, 3].forEach((q) => snare(buf, t0 + q * beat, 0.45, r));
        for (let k = 0; k < 8; k++) hat(buf, t0 + k * beat / 2 + swing(k), k % 2 ? 0.3 : 0.5, r);
        bass(buf, t0, beat * 1.8, notes[0] - 24, { gain: 0.32, sub: true });
        bass(buf, t0 + beat * 2.5, beat * 1.3, notes[0] - 24, { gain: 0.3, sub: true });
        break;
      case 'house':
        for (let q = 0; q < 4; q++) kick(buf, t0 + q * beat, 0.9);
        [1, 3].forEach((q) => snare(buf, t0 + q * beat, 0.5, r, true));
        for (let q = 0; q < 4; q++) hat(buf, t0 + q * beat + beat / 2, 0.55, r, true);
        for (let k = 0; k < 16; k++) if (k % 4 !== 0) hat(buf, t0 + (k * beat) / 4, 0.22, r);
        for (let q = 0; q < 4; q++) bass(buf, t0 + q * beat + beat / 2, beat * 0.42, notes[0] - 24, { gain: 0.3 });
        break;
      case 'trap': {
        // Half-time: kick + long 808 on 1, clap on 3, 16th hats with a roll at the end of every 2nd bar.
        kick(buf, t0, 0.9, true);
        bass(buf, t0, beat * 1.4, notes[0] - 24, { gain: 0.42, sub: true, glideFrom: b % 2 ? notes[0] - 19 : null });
        if (b % 2) {
          kick(buf, t0 + beat * 2.5, 0.75, true);
          bass(buf, t0 + beat * 2.5, beat * 1.2, notes[1] - 24, { gain: 0.38, sub: true });
        }
        snare(buf, t0 + beat * 2, 0.6, r, true);
        for (let k = 0; k < 16; k++) {
          const roll = b % 2 && k >= 12;
          if (roll) for (let x = 0; x < 3; x++) hat(buf, t0 + (k * beat) / 4 + (x * beat) / 12, 0.3, r);
          else hat(buf, t0 + (k * beat) / 4, k % 2 ? 0.25 : 0.38, r);
        }
        break;
      }
      case 'quirky':
        // Boom-chick: bass root / fifth on 1 and 3, claps on 2 and 4, woodblock ticks.
        kick(buf, t0, 0.7);
        kick(buf, t0 + beat * 2, 0.6);
        bass(buf, t0, beat * 0.45, notes[0] - 24, { gain: 0.32 });
        bass(buf, t0 + beat * 2, beat * 0.45, notes[2] - 24, { gain: 0.3 });
        [1, 3].forEach((q) => snare(buf, t0 + q * beat, 0.4, r, true));
        for (let k = 0; k < 8; k++) if (k % 2) add(buf, t0 + k * beat / 2 + swing(k), 0.05, (t) => 0.12 * Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 90));
        break;
      default: // cinematic: big low hits on 1 and the "and" of 2, toms building, a pulse on 8ths
        kick(buf, t0, 1, true);
        kick(buf, t0 + beat * 1.5, 0.7, true);
        snare(buf, t0 + beat * 3, 0.35, r);
        for (let k = 0; k < 8; k++) bass(buf, t0 + (k * beat) / 2, beat * 0.4, notes[0] - 12, { gain: 0.12 });
        break;
    }
  }
  // Soft-clip the mix and add a little tape-like warmth.
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const g = peak > 0 ? 1.2 / peak : 1;
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * g) * 0.9;
  const beats = [];
  for (let t = 0; t < seconds + bar; t += beat) beats.push(round(t, 3));
  return { samples: buf, bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), drop: round(dropBar * bar, 3) };
}

/** Compose and master to `outFile` (.m4a). Returns { file, preset, bpm, drop, beats, downbeats }. */
export async function makeBeat({ sound, seconds, drop = null, outFile, signal }) {
  const preset = pickPreset(sound);
  const song = composeBeat({ preset, seconds, drop, seed: hash(`${sound?.vibe}${sound?.style}${seconds}`) });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const raw = `${outFile}.raw.f32`;
  await fs.writeFile(raw, Buffer.from(song.samples.buffer));
  // Stereo width (Haas), a small room, then streaming loudness; trimmed to the video with a tail fade.
  const len = seconds + 1;
  const res = await run('ffmpeg', [
    '-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw,
    '-af', [
      'highpass=f=28', 'pan=stereo|c0=c0|c1=c0', 'adelay=0|12', 'aecho=0.8:0.5:45|73:0.18|0.12',
      'lowpass=f=13000', 'equalizer=f=3500:t=q:w=1:g=1', `atrim=0:${round(len, 2)}`, `afade=t=out:st=${round(Math.max(0, len - 1.5), 2)}:d=1.5`,
      'loudnorm=I=-14:TP=-1.5:LRA=9',
    ].join(','),
    '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', outFile,
  ], { signal, timeoutMs: 5 * 60_000 });
  await fs.rm(raw, { force: true });
  if (res.code !== 0) throw new PipelineError('Could not make the music.', { detail: tail(res.stderr) });
  return { file: outFile, preset, bpm: song.bpm, drop: song.drop, beats: song.beats, downbeats: song.downbeats };
}

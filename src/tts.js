import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, tail, round, PipelineError } from './util.js';
import { ensureMlPackages } from './ml.js';

/**
 * AI voiceover with Kokoro-82M (Apache-2.0 code and weights — fine for monetised videos), running
 * on the CPU through kokoro-js. The package (~700 MB with ONNX Runtime, shared with the library's
 * search models) is installed on first use into .tools/ml; the model (~90 MB) is downloaded from
 * Hugging Face on first synthesis.
 */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts-worker.js');

export const VOICES = {
  am_michael: 'Michael — US male, warm',
  am_fenrir: 'Fenrir — US male, deep',
  am_puck: 'Puck — US male, energetic',
  am_onyx: 'Onyx — US male, low & calm',
  bm_george: 'George — UK male, documentary',
  bm_fable: 'Fable — UK male, storyteller',
  af_heart: 'Heart — US female, warm',
  af_bella: 'Bella — US female, bright',
  af_nicole: 'Nicole — US female, soft',
  bf_emma: 'Emma — UK female, clear',
};
export const VOICEOVER_MODES = ['off', 'auto', 'on'];

/** Path of kokoro-js' entry module (shared local AI runtime, installed on first use). */
export async function ensureKokoro(toolsDir) {
  const nm = await ensureMlPackages(toolsDir);
  return path.join(nm, 'kokoro-js', 'dist', 'kokoro.js');
}

/** Synthesise each line to a WAV in outDir: [{ file, duration }]. */
export async function synthesize(lines, { toolsDir, voice = 'am_michael', speed = 1, outDir, signal }) {
  const modulePath = await ensureKokoro(toolsDir);
  await fs.mkdir(outDir, { recursive: true });
  const r = await run(process.execPath, [WORKER], {
    input: JSON.stringify({ modulePath, lines, voice: VOICES[voice] ? voice : 'am_michael', speed, outDir }),
    timeoutMs: 20 * 60_000,
    signal,
  });
  if (r.code !== 0) throw new PipelineError('The voiceover engine failed.', { detail: tail(r.stderr) });
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
}

/**
 * Place synthesised lines on the timeline: each at its planned start, pushed later if it would
 * overlap the previous line (0.2 s gap); lines that would run past the end are dropped.
 */
export function scheduleLines(lines, rendered, total) {
  const out = [];
  let free = 0;
  lines.forEach((l, i) => {
    const r = rendered[i];
    if (!r) return;
    const start = round(Math.max(l.start, free), 3);
    if (start + r.duration > total - 0.15) return;
    out.push({ ...l, file: r.file, start, end: round(start + r.duration, 3) });
    free = start + r.duration + 0.2;
  });
  return out;
}

/**
 * Word timings for captions: spread each line's duration over its words by length, with small pauses
 * after punctuation (Kokoro gives no timestamps; this lands within a word or so).
 */
export function estimateWords(placed) {
  const words = [];
  for (const l of placed) {
    const parts = l.text.split(/\s+/).filter(Boolean);
    const weight = (w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length) + (/[,.!?;:]$/.test(w) ? 3 : 0);
    const totalW = parts.reduce((n, w) => n + weight(w), 0) || 1;
    let t = l.start + 0.05;
    const span = l.end - l.start - 0.1;
    for (const w of parts) {
      const d = (weight(w) / totalW) * span;
      const pause = /[,.!?;:]$/.test(w) ? Math.min(0.18, d * 0.35) : 0;
      words.push({ word: w, start: round(t, 3), end: round(t + d - pause, 3) });
      t += d;
    }
  }
  return words;
}

/** Mix placed lines into one narration track, level-matched to the studio voice (-16 LUFS). */
export async function mixNarration(placed, out, total, { signal } = {}) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const args = ['-v', 'error', '-y'];
  for (const l of placed) args.push('-i', l.file);
  const chains = placed.map((l, i) => `[${i}]aformat=sample_rates=48000:channel_layouts=mono,adelay=${Math.round(l.start * 1000)}:all=1[d${i}]`);
  const mix = `${placed.map((_, i) => `[d${i}]`).join('')}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${round(total, 3)},highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=7`;
  args.push('-filter_complex', `${chains.join(';')};${mix}`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', out);
  const r = await run('ffmpeg', args, { signal, timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new PipelineError('Could not mix the voiceover.', { detail: tail(r.stderr) });
  return out;
}

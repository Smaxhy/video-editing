import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMlPackages } from './ml.js';
import { run, tail, round, PipelineError } from './util.js';

/**
 * AI background music made on this machine (MusicGen small, CPU — no API): when the library has no
 * music, ClipForge composes a track from the vibe Claude planned ("warm lo-fi beat, soft piano, 85
 * bpm…"), masters it to streaming loudness and loops it seamlessly to the video's length.
 * Note: the MusicGen weights are licensed CC-BY-NC 4.0 (non-commercial).
 */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'musicgen-worker.js');
export const MUSICGEN_SECONDS = 30; // the model's longest clip

/** Text prompt for the music model from the planner's sound idea. Exported for tests. */
export function musicPrompt(sound, fallback = 'upbeat modern background music') {
  if (sound?.prompt) return `${sound.prompt}, instrumental, no vocals, high quality`;
  const parts = [sound?.style, sound?.vibe && `${sound.vibe} mood`, sound?.energy && `${sound.energy} energy`, sound?.bpm && `${sound.bpm} bpm`].filter(Boolean);
  return `${parts.length ? parts.join(', ') : fallback}, instrumental, no vocals, high quality`;
}

/**
 * ffmpeg filter that joins `n` inputs (the same clip, opened n times) with `fade`-second crossfades.
 * Exported for tests.
 */
export function loopFilter(n, fade) {
  if (n <= 1) return '[0:a]anull[out]';
  const chain = [];
  let prev = '0:a';
  for (let i = 1; i < n; i++) {
    const label = i === n - 1 ? 'out' : `x${i}`;
    chain.push(`[${prev}][${i}:a]acrossfade=d=${fade}:c1=tri:c2=tri[${label}]`);
    prev = label;
  }
  return chain.join(';');
}

/** Compose a track of at least `seconds` into outFile (.m4a). Returns { file, prompt, seconds }. */
export async function generateMusic({ toolsDir, sound, seconds, outFile, signal }) {
  const nm = await ensureMlPackages(toolsDir);
  const prompt = musicPrompt(sound);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const wav = `${outFile}.raw.wav`;
  const len = Math.min(MUSICGEN_SECONDS, Math.max(8, Math.ceil(seconds) + 1));
  const r = await run(process.execPath, [WORKER], {
    input: JSON.stringify({
      entry: path.join(nm, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'),
      cacheDir: path.join(toolsDir, 'ml', 'models'),
      prompt,
      seconds: len,
      out: wav,
    }),
    timeoutMs: 30 * 60_000,
    signal,
  });
  if (r.code !== 0) throw new PipelineError('The AI music engine failed.', { detail: tail(r.stderr) });
  const made = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  // Loop with 2 s crossfades until it covers the video; then master: rumble cut, gentle stereo width,
  // streaming loudness.
  const fade = 2;
  const n = Math.min(12, Math.max(1, Math.ceil((seconds - fade) / Math.max(1, made.seconds - fade))));
  const res = await run('ffmpeg', [
    '-v', 'error', '-y', ...Array.from({ length: n }, () => ['-i', wav]).flat(),
    '-filter_complex', `${loopFilter(n, fade)};[out]highpass=f=30,aformat=channel_layouts=stereo,extrastereo=m=1.3,loudnorm=I=-14:TP=-1.5:LRA=9[m]`,
    '-map', '[m]', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', outFile,
  ], { signal, timeoutMs: 5 * 60_000 });
  await fs.rm(wav, { force: true });
  if (res.code !== 0) throw new PipelineError('Could not master the AI music.', { detail: tail(res.stderr) });
  return { file: outFile, prompt, seconds: round(Math.max(made.seconds, n * (made.seconds - fade) + fade), 2) };
}

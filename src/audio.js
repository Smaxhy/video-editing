import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { run, tail, exists, round, PipelineError } from './util.js';

/**
 * Studio sound: every clip's audio goes through a broadcast-style chain before it is mixed —
 *   speech:  high-pass 80 Hz → DeepFilterNet3 denoise → de-mud / presence / air EQ → gentle
 *            compression → de-esser → level-matched to -16 LUFS so every clip sounds the same;
 *   ambient: (POV, B-roll — no words) high-pass 40 Hz → level-matched to -20 LUFS, dynamics kept,
 *            so a chainsaw still sounds like a chainsaw.
 * Only the part of the clip the edit uses is processed (cached per range).
 * DeepFilterNet (MIT/Apache-2.0) runs as its standalone binary — no Python needed; without it the
 * chain falls back to FFmpeg's own spectral denoiser.
 */

const DF_VERSION = '0.5.6';
const DF_ASSET = { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-gnu' };
let dfPromise = null;

/** Path of the deep-filter binary (downloaded once into toolsDir), or null when unavailable. */
export function ensureDeepFilter(toolsDir) {
  dfPromise ||= (async () => {
    if (process.env.DEEP_FILTER_BIN) return process.env.DEEP_FILTER_BIN;
    const dir = path.join(toolsDir, `deepfilter-${DF_VERSION}`);
    const bin = path.join(dir, 'deep-filter');
    if (fsSync.existsSync(bin)) return bin;
    const asset = process.platform === 'linux' && DF_ASSET[process.arch];
    if (!asset) return null;
    try {
      const r = await fetch(`https://github.com/Rikorose/DeepFilterNet/releases/download/v${DF_VERSION}/deep-filter-${DF_VERSION}-${asset}`);
      if (!r.ok) return null;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${bin}.part`, Buffer.from(await r.arrayBuffer()));
      await fs.chmod(`${bin}.part`, 0o755);
      if ((await run(`${bin}.part`, ['--version'], { timeoutMs: 30_000 })).code !== 0) throw new Error('does not run here');
      await fs.rename(`${bin}.part`, bin);
      console.log(`  Installed DeepFilterNet ${DF_VERSION} for studio sound.`);
      return bin;
    } catch (err) {
      console.error('  DeepFilterNet unavailable — using FFmpeg denoise:', err.message);
      await fs.rm(`${bin}.part`, { force: true }).catch(() => {});
      dfPromise = null; // try again next time
      return null;
    }
  })();
  return dfPromise;
}

/** FFmpeg filter chain applied after denoising. Exported for tests. */
export function voiceChain({ speech }) {
  if (!speech) return 'highpass=f=40,loudnorm=I=-20:TP=-2:LRA=11';
  return [
    'highpass=f=80:poles=2',
    'equalizer=f=250:t=q:w=1.1:g=-2.5', // less boxy / muddy
    'equalizer=f=3200:t=q:w=1.4:g=2.5', // presence — words cut through music
    'highshelf=f=10000:g=1.5', // a little air
    'acompressor=threshold=-21dB:ratio=3:attack=8:release=140:makeup=3:knee=4',
    'deesser=i=0.35:m=0.5:f=0.5',
    'loudnorm=I=-16:TP=-1.5:LRA=7',
    'alimiter=limit=0.89:attack=3:release=60:level=disabled',
  ].join(',');
}

/** True when a transcript has real speech (not one stray word over wind noise). */
export function hasSpeech(transcript, start = 0, end = Infinity) {
  const words = transcript?.words?.length ? transcript.words : [];
  if (words.length) return words.filter((w) => w.end > start && w.start < end).length >= 3;
  const text = (transcript?.segments || []).filter((s) => s.end > start && s.start < end).map((s) => s.text).join(' ');
  return text.trim().split(/\s+/).filter(Boolean).length >= 3;
}

/**
 * Process [start, end) of `src`'s audio into `out` (AAC). The result starts at `start` of the source,
 * so the composition plays it with media-start = sceneStart - start.
 */
export async function polishAudio(src, out, { start = 0, end, speech, deepFilter, signal }) {
  if (await exists(out)) return out;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const work = `${out}.work`;
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  try {
    const span = ['-ss', String(round(start, 3)), ...(end ? ['-t', String(round(end - start, 3))] : [])];
    const raw = path.join(work, 'voice.wav');
    // deep-filter wants 48 kHz WAV; mono keeps it fast (voice is mono anyway).
    let r = await run('ffmpeg', ['-v', 'error', '-y', ...span, '-i', src, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', raw], { signal, timeoutMs: 20 * 60_000 });
    if (r.code !== 0) throw new PipelineError('Could not read the clip audio.', { detail: tail(r.stderr) });

    let cleaned = raw;
    let denoise = '';
    if (speech) {
      if (deepFilter) {
        // -a 24: keep a little room tone instead of an unnatural dead silence; -D: no added delay.
        r = await run(deepFilter, ['-D', '-a', '24', '-o', path.join(work, 'df'), raw], { signal, timeoutMs: 30 * 60_000 });
        const df = path.join(work, 'df', 'voice.wav');
        if (r.code === 0 && (await exists(df))) cleaned = df;
        else denoise = 'afftdn=nr=12:nf=-40:tn=1,';
      } else {
        denoise = 'afftdn=nr=12:nf=-40:tn=1,';
      }
    }
    const tmp = `${out}.part.m4a`;
    r = await run('ffmpeg', [
      '-v', 'error', '-y', '-i', cleaned, '-af', `${denoise}${voiceChain({ speech })}`,
      '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', tmp,
    ], { signal, timeoutMs: 20 * 60_000 });
    if (r.code !== 0) throw new PipelineError('The studio-sound chain failed.', { detail: tail(r.stderr) });
    await fs.rename(tmp, out);
    return out;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Smallest window covering every range a plan uses of each clip: { clipId: [start, end] }. */
export function usedWindows(versions, pad = 0.5) {
  const w = {};
  for (const v of versions) {
    for (const s of v.plan.scenes) {
      const cur = w[s.clip];
      w[s.clip] = cur ? [Math.min(cur[0], s.start), Math.max(cur[1], s.end)] : [s.start, s.end];
    }
  }
  for (const k of Object.keys(w)) w[k] = [round(Math.max(0, w[k][0] - pad), 2), round(w[k][1] + pad, 2)];
  return w;
}

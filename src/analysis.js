import fs from 'node:fs/promises';
import path from 'node:path';
import { run, tail, exists, round } from './util.js';
import { ROOT, PYTHON, onPath } from './tools.js';

const ANALYZE_PY = path.join(ROOT, 'py', 'analyze.py');

/**
 * Silent ranges in a clip, in seconds: [[start, end], ...].
 * Uses auto-editor when installed (loudness analysis tuned for editing), otherwise
 * FFmpeg's silencedetect filter, so every install gets dead-air data.
 */
export async function detectSilences(file, { useAutoEditor, signal }) {
  if (useAutoEditor) {
    const tmp = `${file}.ae-${process.pid}.json`;
    try {
      const res = await run('auto-editor', [file, '--export', 'v1', '-o', tmp, '-tb', '30'], { signal, timeoutMs: 20 * 60_000 });
      if (res.code === 0 && (await exists(tmp))) {
        const v1 = JSON.parse(await fs.readFile(tmp, 'utf8'));
        const silences = (v1.chunks || [])
          .filter(([, , speed]) => speed >= 99999 || speed === 0)
          .map(([a, b]) => [round(a / 30), round(b / 30)])
          .filter(([a, b]) => b - a >= 0.25);
        return { engine: 'auto-editor', silences };
      }
    } catch {
      /* fall through to ffmpeg */
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  const res = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'], {
    signal,
  });
  const silences = [];
  let start = null;
  for (const line of res.stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start != null) {
      silences.push([round(start), round(Number(e[1]))]);
      start = null;
    }
  }
  return { engine: 'ffmpeg', silences };
}

/**
 * Analyze one clip for the edit planner and the renderer. Results are cached in cacheFile;
 * only features that are requested but not yet cached are computed.
 * features: { silence: bool, shots: bool, faces: bool }, tools: detectTools() result.
 */
export async function analyzeClip(clip, { cacheFile, features, tools, signal }) {
  const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8').catch(() => '{}'));
  const out = { ...cached };
  const notes = [];

  if (features.silence && clip.hasAudio && !out.silences) {
    const r = await detectSilences(clip.path, { useAutoEditor: tools.autoEditor, signal });
    out.silences = r.silences;
    out.silenceEngine = r.engine;
  }

  const wantShots = features.shots && tools.sceneDetect && !out.shots;
  const wantFaces = features.faces && tools.faces && !out.faces;
  // "track" = subject path for smart reframing (YuNet faces, else the action). Re-run when YuNet
  // becomes available after a Haar-only pass.
  const wantTrack = features.track && tools.faces && (!out.track || (features.yunet && out.trackEngine !== 'yunet'));
  if (wantShots || wantFaces || wantTrack) {
    const args = [ANALYZE_PY, clip.path];
    if (wantShots) args.push('--shots');
    if (wantFaces) args.push('--faces');
    if (wantTrack) args.push('--track', ...(features.yunet ? ['--yunet', features.yunet] : []));
    const res = await run(PYTHON, args, { signal, timeoutMs: 30 * 60_000 });
    try {
      const data = JSON.parse(res.stdout);
      if (data.shots) out.shots = data.shots;
      if (data.faces) out.faces = data.faces;
      if (data.track) {
        out.track = data.track;
        out.trackEngine = features.yunet ? 'yunet' : 'haar';
      }
      for (const [k, v] of Object.entries(data.errors || {})) notes.push(`${clip.name}: ${k} analysis failed (${v})`);
    } catch {
      notes.push(`${clip.name}: footage analysis failed — ${tail(res.stderr, 3)}`);
    }
  }

  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(out));
  return { ...out, notes };
}

/**
 * Isolate the voice of a clip with Demucs (two-stem "vocals" separation) and save it as AAC.
 * Returns outPath, or throws with Demucs' own error output.
 */
export async function isolateVoice(clipPath, outPath, { signal } = {}) {
  if (await exists(outPath)) return outPath;
  const work = `${outPath}.work`;
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  try {
    // Demucs reads plain WAV most reliably; extract the audio first.
    const wav = path.join(work, 'input.wav');
    const ex = await run('ffmpeg', ['-v', 'error', '-y', '-i', clipPath, '-vn', '-ac', '2', '-ar', '44100', wav], { signal });
    if (ex.code !== 0) throw new Error(tail(ex.stderr));

    const [cmd, pre] = onPath('demucs') ? ['demucs', []] : [PYTHON, ['-m', 'demucs']];
    const res = await run(cmd, [...pre, '--two-stems', 'vocals', '-n', 'htdemucs', '-o', work, wav], {
      signal,
      timeoutMs: 60 * 60_000,
    });
    const vocals = path.join(work, 'htdemucs', 'input', 'vocals.wav');
    if (res.code !== 0 || !(await exists(vocals))) throw new Error(tail(res.stderr || res.stdout, 8));

    const enc = await run('ffmpeg', ['-v', 'error', '-y', '-i', vocals, '-c:a', 'aac', '-b:a', '192k', outPath], { signal });
    if (enc.code !== 0) throw new Error(tail(enc.stderr));
    return outPath;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Cut the background out of an image with rembg. Returns outPath, or throws. */
export async function cutoutImage(inPath, outPath, { signal } = {}) {
  const res = await run('rembg', ['i', inPath, outPath], { signal, timeoutMs: 10 * 60_000 });
  if (res.code !== 0 || !(await exists(outPath))) throw new Error(tail(res.stderr || res.stdout, 6));
  return outPath;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { run, round, clamp, exists } from './util.js';
import { shakeFromTrf } from './picture.js';

/**
 * Footage quality, measured with FFmpeg so bad clips are never picked: sharpness (blurdetect),
 * exposure (signalstats), camera shake (vid.stab motion) and sound level (EBU R128). Combined into a
 * 0–100 score plus plain flags ("blurry", "dark", "shaky", …) shown to Claude and in the library.
 */

/** Combine raw measurements into { score, flags }. Exported for tests. */
export function scoreQuality({ blur, y, ylow, yhigh, shake, lufs, hasAudio }) {
  const flags = [];
  const sharp = blur == null ? 0.8 : clamp(1 - (blur - 4.5) / 6, 0, 1);
  if (sharp < 0.5) flags.push('blurry');
  let exposure = 1;
  if (y != null) {
    if (y < 55) (exposure = clamp((y - 25) / 30, 0, 1)), flags.push('dark');
    else if (y > 200) (exposure = clamp((235 - y) / 35, 0, 1)), flags.push('overexposed');
    if (yhigh - ylow < 60) (exposure = Math.min(exposure, 0.7)), flags.push('flat');
  }
  const steady = clamp(1 - (shake - 1) / 3, 0, 1);
  if (shake > 2) flags.push('shaky');
  let sound = 1;
  if (hasAudio && lufs != null) {
    if (lufs < -45) (sound = 0.6), flags.push('silent');
    else if (lufs > -8) (sound = 0.6), flags.push('clipping audio');
  }
  const score = Math.round(100 * (0.4 * sharp + 0.25 * exposure + 0.25 * steady + 0.1 * sound));
  return { score, flags };
}

/** Measure a clip (sampled frames + a quick motion pass). Returns the stored quality object. */
export async function measureQuality(file, { hasAudio, work, signal }) {
  await fs.mkdir(work, { recursive: true });
  try {
    const frames = await run('ffmpeg', [
      '-hide_banner', '-v', 'error', '-i', file, '-an',
      '-vf', "select='not(mod(n\\,15))',scale=480:-2,format=yuv420p,blurdetect,signalstats,metadata=print:file=-", '-f', 'null', '-',
    ], { signal, timeoutMs: 20 * 60_000 });
    const avg = (key) => {
      const v = [...frames.stdout.matchAll(new RegExp(`lavfi\\.${key}=([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const trf = path.join(work, 'q.trf');
    const motion = await run('ffmpeg', [
      '-hide_banner', '-nostats', '-i', file,
      '-vf', `scale=480:-2,vidstabdetect=shakiness=6:accuracy=9:stepsize=6:result=${trf}`,
      ...(hasAudio ? ['-af', 'ebur128'] : ['-an']), '-f', 'null', '-',
    ], { signal, timeoutMs: 30 * 60_000 });
    const lufsAll = [...motion.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
    const m = {
      blur: avg('blur'),
      y: avg('signalstats\\.YAVG'),
      ylow: avg('signalstats\\.YLOW'),
      yhigh: avg('signalstats\\.YHIGH'),
      shake: (await exists(trf)) ? shakeFromTrf(await fs.readFile(trf, 'utf8'), 480) : 0,
      lufs: lufsAll.length ? Number(lufsAll[lufsAll.length - 1][1]) : null,
      hasAudio,
    };
    const { score, flags } = scoreQuality(m);
    return {
      score,
      flags,
      blur: m.blur == null ? null : round(m.blur, 2),
      brightness: m.y == null ? null : Math.round(m.y),
      shake: m.shake,
      lufs: m.lufs,
      measuredAt: Date.now(),
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

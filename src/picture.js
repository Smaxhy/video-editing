import fs from 'node:fs/promises';
import path from 'node:path';
import { run, tail, exists, round, clamp, PipelineError } from './util.js';

/**
 * Picture polish: per clip, the part the edit uses is measured and re-encoded once (cached) with
 *   - exposure/contrast correction (gamma toward a healthy mid-grey, gentle contrast for flat shots),
 *   - white-balance correction (half of any colour cast, so golden hour stays golden),
 *   - a touch of saturation (the "social pop"), light denoise on dark footage,
 *   - two-pass vid.stab stabilisation, only for clips that are actually shaky,
 *   - light CAS sharpening, and a keyframe every second so the renderer seeks frame-accurately.
 * Everything is plain FFmpeg — no GPU, no models.
 */

const SAMPLE_W = 640;

/** Mean of signalstats over sampled frames: { y, u, v, sat, ylow, yhigh } (8-bit values). */
export function parseSignalstats(text) {
  const keys = { YAVG: 'y', UAVG: 'u', VAVG: 'v', SATAVG: 'sat', YLOW: 'ylow', YHIGH: 'yhigh' };
  const sums = {};
  const counts = {};
  for (const m of text.matchAll(/lavfi\.signalstats\.(YAVG|UAVG|VAVG|SATAVG|YLOW|YHIGH)=([\d.]+)/g)) {
    const k = keys[m[1]];
    sums[k] = (sums[k] || 0) + Number(m[2]);
    counts[k] = (counts[k] || 0) + 1;
  }
  if (!counts.y) return null;
  return Object.fromEntries(Object.keys(sums).map((k) => [k, round(sums[k] / counts[k], 2)]));
}

/**
 * Camera shake from a vid.stab transforms file: per-frame global motion (median of the local motion
 * vectors) minus its 0.5 s moving average = jitter. Returns mean jitter in % of the frame width.
 */
export function shakeFromTrf(text, width = SAMPLE_W) {
  const med = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const motion = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('Frame ')) continue;
    const lms = [...line.matchAll(/\(LM (-?\d+) (-?\d+) /g)].map((m) => [Number(m[1]), Number(m[2])]);
    motion.push(lms.length ? [med(lms.map((l) => l[0])), med(lms.map((l) => l[1]))] : [0, 0]);
  }
  if (motion.length < 10) return 0;
  // vid.stab reports frame-to-frame motion; integrate to a camera path, then measure how far the path
  // strays from its smoothed version (= the shake a stabiliser would remove).
  const pathX = [];
  const pathY = [];
  motion.reduce(([x, y], [dx, dy]) => (pathX.push(x + dx), pathY.push(y + dy), [x + dx, y + dy]), [0, 0]);
  const W = Math.min(15, Math.floor((motion.length - 1) / 2));
  let sum = 0;
  let n = 0;
  // Only frames with a full window on both sides — at the edges a moving average lags a smooth pan.
  for (let i = W; i < motion.length - W; i++, n++) {
    const a = i - W;
    const b = i + W + 1;
    let sx = 0;
    let sy = 0;
    for (let j = a; j < b; j++) {
      sx += pathX[j];
      sy += pathY[j];
    }
    sum += Math.hypot(pathX[i] - sx / (b - a), pathY[i] - sy / (b - a));
  }
  return n ? round(((sum / n) / width) * 100, 3) : 0;
}

/** FFmpeg colour filters for the measured stats ('' when nothing needs fixing). Exported for tests. */
export function gradeFilters(st) {
  if (!st) return [];
  const f = [];
  // Exposure: gamma moves the average toward ~118 (mid-grey in video range) without clipping.
  const mean = clamp((st.y - 16) / 219, 0.02, 0.98);
  const target = 0.47;
  const gamma = Math.abs(mean - target) > 0.08 ? clamp(Math.log(target) / Math.log(mean), 0.85, 1.2) : 1;
  // Contrast: flat / hazy footage (narrow 10–90% spread) gets up to +8%.
  const spread = (st.yhigh - st.ylow) / 219;
  const contrast = spread < 0.5 ? clamp(0.55 / Math.max(spread, 0.2), 1, 1.08) : 1;
  // Saturation: a little pop, more for washed-out footage, none for already vivid shots.
  const saturation = st.sat < 25 ? 1.1 : st.sat < 60 ? 1.06 : 1.02;
  f.push(`eq=gamma=${round(1 / gamma, 3)}:contrast=${round(contrast, 3)}:saturation=${saturation}`);
  // White balance: gently correct a mild cast (U = blue-yellow, V = red-cyan; 128 = neutral). A strong
  // cast is usually the scene itself (a forest, a sunset) — left alone; corrections stay small.
  const du = (st.u - 128) / 128;
  const dv = (st.v - 128) / 128;
  const cast = Math.max(Math.abs(du), Math.abs(dv));
  if (cast > 0.025 && cast < 0.12) {
    const bm = clamp(-du * 0.6, -0.05, 0.05);
    const rm = clamp(-dv * 0.6, -0.05, 0.05);
    f.push(`colorbalance=rm=${round(rm, 3)}:bm=${round(bm, 3)}:gm=${round(-(rm + bm) / 2, 3)}`);
  }
  // Dark footage is noisy: light temporal denoise before sharpening.
  if (st.y < 70) f.push('hqdn3d=2:1.5:4:4');
  return f;
}

/** HDR (PQ / HLG — most iPhone and many Android videos) → SDR BT.709, so colours look right. */
export const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** True when the video is HDR (PQ or HLG transfer). */
export async function isHdr(src) {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', src]);
  return /smpte2084|arib-std-b67/.test(r.stdout);
}

/** Measure colour/exposure and shake of [start, end) of a clip (always as 8-bit SDR values). */
export async function measureClip(src, { start = 0, end, work, signal, hdr = false }) {
  const span = ['-ss', String(round(start, 3)), ...(end ? ['-t', String(round(end - start, 3))] : [])];
  const stats = await run('ffmpeg', [
    '-hide_banner', '-v', 'error', ...span, '-i', src, '-an',
    // format=yuv420p: 10-bit footage otherwise reports 0–1023 values, which read as a huge colour cast.
    '-vf', `select='not(mod(n\\,15))',${hdr ? `${TONEMAP},` : ''}scale=${SAMPLE_W}:-2,format=yuv420p,signalstats,metadata=print:file=-`, '-f', 'null', '-',
  ], { signal, timeoutMs: 10 * 60_000 });
  const trf = path.join(work, 'motion.trf');
  const det = await run('ffmpeg', [
    '-hide_banner', '-v', 'error', ...span, '-i', src, '-an',
    '-vf', `scale=${SAMPLE_W}:-2,vidstabdetect=shakiness=6:accuracy=9:stepsize=6:result=${trf}`, '-f', 'null', '-',
  ], { signal, timeoutMs: 20 * 60_000 });
  const shake = det.code === 0 && (await exists(trf)) ? shakeFromTrf(await fs.readFile(trf, 'utf8')) : 0;
  return { stats: parseSignalstats(stats.stdout), shake };
}

/** Creative looks laid over the correction (a style's colour grade). Exported for tests. */
export const LOOKS = {
  natural: [],
  warm: ['colortemperature=temperature=5300:mix=0.55', 'eq=saturation=1.05'],
  cool: ['colortemperature=temperature=8200:mix=0.5'],
  moody: ['eq=brightness=-0.03:contrast=1.08:saturation=0.82', 'vignette=PI/5'],
  vibrant: ['eq=saturation=1.22:contrast=1.05'],
  film: ['eq=contrast=0.96:saturation=0.88', 'colorbalance=rs=0.04:bs=-0.03:rh=0.03:bh=-0.04', 'noise=alls=5:allf=t'],
};

export const SHAKY = 1.5; // % of frame width of jitter — above this, stabilise (a tripod shot measures ~0)

/**
 * Polished, seek-friendly copy of [start, end) of `src`. Returns { path, offset, applied } where
 * offset = the source second the copy starts at.
 */
export async function preparePicture(src, out, { start = 0, end, grade = true, stabilize = true, look = 'natural', signal }) {
  if (await exists(`${out}.json`) && (await exists(out))) {
    const meta = JSON.parse(await fs.readFile(`${out}.json`, 'utf8'));
    return { path: out, offset: start, applied: meta.applied };
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const work = `${out}.work`;
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  try {
    const hdr = await isHdr(src);
    const { stats, shake } = await measureClip(src, { start, end, work, signal, hdr });
    const span = ['-ss', String(round(start, 3)), ...(end ? ['-t', String(round(end - start, 3))] : [])];
    const vf = [];
    const applied = [];
    if (hdr) {
      vf.push(TONEMAP);
      applied.push('HDR converted');
    }
    if (stabilize && shake > SHAKY) {
      const trf = path.join(work, 'full.trf');
      const det = await run('ffmpeg', ['-hide_banner', '-v', 'error', ...span, '-i', src, '-an',
        '-vf', `vidstabdetect=shakiness=7:accuracy=12:result=${trf}`, '-f', 'null', '-'], { signal, timeoutMs: 30 * 60_000 });
      if (det.code === 0 && (await exists(trf))) {
        // optzoom=1: zoom just enough to hide the moving borders; smoothing ≈ 0.5 s of camera path.
        vf.push(`vidstabtransform=input=${trf}:smoothing=15:optzoom=1:interpol=bicubic`);
        applied.push(`stabilised (shake ${shake}%)`);
      }
    }
    const g = grade ? gradeFilters(stats) : [];
    if (g.length) applied.push('colour & exposure corrected');
    vf.push(...g);
    if (LOOKS[look]?.length) {
      vf.push(...LOOKS[look]);
      applied.push(`${look} look`);
    }
    if (grade) vf.push('cas=strength=0.35');
    vf.push('format=yuv420p');
    const tmp = `${out}.part.mp4`;
    const r = await run('ffmpeg', [
      '-v', 'error', '-y', ...span, '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-g', '30', '-keyint_min', '30',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp,
    ], { signal, timeoutMs: 60 * 60_000 });
    if (r.code !== 0) throw new PipelineError('Could not polish the clip.', { detail: tail(r.stderr) });
    await fs.rename(tmp, out);
    await fs.writeFile(`${out}.json`, JSON.stringify({ stats, shake, applied, filters: vf }, null, 2));
    return { path: out, offset: start, applied };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

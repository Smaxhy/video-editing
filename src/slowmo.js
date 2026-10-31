import fs from 'node:fs/promises';
import path from 'node:path';
import { run, tail, round, exists, PipelineError, FIT_1080 } from './util.js';

/**
 * Pro slow motion. Phone footage is usually 30 fps, so a 0.5× scene shows every frame twice and
 * stutters. ClipForge renders the slowed part with motion-compensated frame interpolation (FFmpeg
 * minterpolate) so it plays back at a smooth 30 fps, and ramps into the slow motion (0.85× → 0.65× →
 * slow) instead of snapping to it — the way editors speed-ramp into a peak.
 */

export const SLOW = 0.8; // scenes at or below this speed get interpolated frames
const RAMP = [0.85, 0.65]; // ramp-in steps, 0.15 s of source each

/** Frame rate of a video's first stream. */
export async function sourceFps(file) {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', file]);
  const [n, d] = r.stdout.trim().split('/').map(Number);
  return n && d ? n / d : 30;
}

/**
 * Interpolated copy of [start, end) (source seconds; the file starts at `offset`) dense enough to play
 * at `speed` at 30 fps. Returns the path, or null when the source already has enough frames.
 */
export async function smoothSlowMo(src, out, { start, end, speed, offset = 0, signal }) {
  // Ramp steps of a fraction of a second gain nothing visible (and can come out with no frames).
  if (end - start < 0.4) return null;
  if ((await exists(out)) && (await hasVideoFrames(out))) return out;
  // 60 fps is plenty for a smooth 30 fps slow-mo down to ~0.5×; more frames cost minutes each.
  const target = Math.min(60, Math.ceil(30 / speed));
  if ((await sourceFps(src)) >= target * 0.95) return null;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.part.mp4`;
  const r = await run('ffmpeg', [
    '-v', 'error', '-y', '-ss', String(round(Math.max(0, start - offset), 3)), '-t', String(round(end - start, 3)), '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    // Interpolate at the output size (≤1080p), not the 4K original — ~4× less work, same result on screen.
    // Motion-compensated frames (best, ~30 s of work per source second) for short slow-mo hits; frame
    // blending (near-instant) for longer stretches, so one long slow shot can't add half an hour.
    '-vf', `${FIT_1080},minterpolate=fps=${target}:${end - start <= 1.5 ? 'mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=1' : 'mi_mode=blend'},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-g', String(target),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp,
  ], { signal, timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw new PipelineError('Could not interpolate the slow motion.', { detail: tail(r.stderr) });
  // Only a file with real video frames may replace the shot (else the render rejects it).
  if (!(await hasVideoFrames(tmp))) {
    await fs.rm(tmp, { force: true });
    return null;
  }
  await fs.rename(tmp, out);
  return out;
}

/** True when the file has a video stream with at least one decoded frame. */
export async function hasVideoFrames(file) {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return r.code === 0 && Number(r.stdout.trim()) > 0;
}

/**
 * Ramp into every slow non-talking scene: its first 0.3 s of source plays at 0.85× then 0.65× before
 * settling into the slow speed. The scene's out-point moves so its output length — and every cut
 * after it — stays where beat sync put it. Exported for tests.
 */
export function rampSlowMo(plan, { talking, clipDuration }) {
  const scenes = [];
  let ramps = 0;
  for (const s of plan.scenes) {
    const lead = RAMP.length * 0.15;
    if (s.speed > SLOW || s.speed < 0.2 || talking(s) || s.end - s.start < lead + 0.4) {
      scenes.push(s);
      continue;
    }
    // Output time the ramp saves vs playing those 0.3 s fully slowed — add it back at the end.
    const saved = lead / s.speed - RAMP.reduce((n, r) => n + 0.15 / r, 0);
    const end = Math.min(clipDuration(s.clip), round(s.end + saved * s.speed, 3));
    let at = s.start;
    RAMP.forEach((r, k) => {
      scenes.push({ ...s, start: round(at, 3), end: round(at + 0.15, 3), speed: r, effect: k === 0 ? s.effect : 'none', ramp: k > 0, peak: k === 0 && s.peak, ...(k > 0 ? { transition: 'cut', transitionDuration: 0 } : {}) });
      at += 0.15;
    });
    scenes.push({ ...s, start: round(at, 3), end, effect: 'none', ramp: true, peak: false, transition: 'cut', transitionDuration: 0 });
    ramps++;
  }
  return { plan: { ...plan, scenes }, ramps };
}

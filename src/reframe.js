import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { round, clamp } from './util.js';

/**
 * Smart reframing (16:9 → 9:16 and friends), AutoFlip-style: per scene, decide between a locked-off
 * crop (subject barely moves) and a tracking crop that follows it with a smoothed, speed-limited
 * virtual camera. Faces win when they're on screen most of the scene; otherwise the action is followed.
 */

const YUNET = 'face_detection_yunet_2023mar.onnx';
const YUNET_URL = `https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/${YUNET}`;

/** YuNet face detector (MIT, 230 KB), downloaded once. Null when unavailable (Haar fallback). */
export async function ensureYunet(toolsDir) {
  const file = path.join(toolsDir, 'models', YUNET);
  if (fsSync.existsSync(file)) return file;
  try {
    const r = await fetch(YUNET_URL);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok || buf.length < 100_000) return null; // an LFS pointer, not the model
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.part`, buf);
    await fs.rename(`${file}.part`, file);
    return file;
  } catch {
    return null;
  }
}

/** object-position % that puts source point (x, y) (0–1) as close to the frame centre as possible. */
export function coverPercent(x, y, clip, W, H) {
  const scale = Math.max(W / clip.width, H / clip.height);
  const axis = (c, size, box) => (size - box < 1 ? 50 : (clamp(c * size - box / 2, 0, size - box) / (size - box)) * 100);
  return { x: axis(x, clip.width * scale, W), y: axis(y, clip.height * scale, H) };
}

/**
 * Camera path for one scene. Returns { x, y } (static) or { keys: [{ t, x, y }] } with t in seconds
 * from the scene's start on the OUTPUT timeline, x/y in object-position percent. Null without data.
 */
export function cameraPath(track, scene, clip, W, H) {
  const { srcStart, srcEnd, speed = 1 } = scene;
  let pts = (track || []).filter((p) => p.t >= srcStart - 0.3 && p.t <= srcEnd + 0.3);
  if (pts.length < 2) return null;
  const faces = pts.filter((p) => p.k === 'face');
  if (faces.length >= pts.length * 0.4) pts = faces;
  pts.sort((a, b) => a.t - b.t);

  // Smooth the subject path (±0.75 s window) so the camera never jitters with the detections.
  const smooth = pts.map((p) => {
    const win = pts.filter((q) => Math.abs(q.t - p.t) <= 0.75);
    return { t: p.t, x: win.reduce((n, q) => n + q.x, 0) / win.length, y: win.reduce((n, q) => n + q.y, 0) / win.length };
  });
  const pos = smooth.map((p) => ({ t: p.t, ...coverPercent(p.x, p.y, clip, W, H) }));
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const med = (a) => [...a].sort((m, n) => m - n)[Math.floor(a.length / 2)];
  // Locked-off when the subject stays within ~12 points of the pan range — calmer and more "shot".
  if (Math.max(...xs) - Math.min(...xs) < 12 && Math.max(...ys) - Math.min(...ys) < 12) {
    return { x: round(med(xs), 2), y: round(med(ys), 2) };
  }
  // Tracking: keyframes every 0.5 s (output time), speed-limited to 18 points per keyframe.
  const at = (src) => {
    const i = pos.findIndex((p) => p.t >= src);
    if (i <= 0) return pos[i === 0 ? 0 : pos.length - 1];
    const a = pos[i - 1];
    const b = pos[i];
    const k = (src - a.t) / Math.max(1e-6, b.t - a.t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  };
  const dur = (srcEnd - srcStart) / speed;
  const keys = [];
  for (let t = 0; t <= dur + 1e-6; t += 0.5) {
    const p = at(srcStart + Math.min(t, dur) * speed);
    const prev = keys[keys.length - 1];
    const lim = (v, pv) => (pv == null ? v : clamp(v, pv - 18, pv + 18));
    keys.push({ t: round(Math.min(t, dur), 3), x: round(lim(p.x, prev?.x), 2), y: round(lim(p.y, prev?.y), 2) });
  }
  return { keys };
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { run, probe, exists, tail, PipelineError } from './util.js';

/**
 * Media library: every uploaded video lives here once and can be used by any number of projects.
 *
 *   library/<assetId>/source.<ext>   the original file, untouched
 *   library/<assetId>/meta.json      name, size, probe data, preview status
 *   library/<assetId>/thumb.jpg      poster frame
 *   library/<assetId>/sprite.jpg     storyboard strip for hover-scrubbing
 *   library/<assetId>/proxy.mp4      small H.264 copy, only when the browser can't play the original
 *   library/<assetId>/cache/…        transcripts, analysis, seekable/blur/voice renders (shared by projects)
 *
 * Previews are made in a background queue (one at a time) so big uploads finish instantly.
 */

export const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|mpg|mpeg|3gp|wmv|flv|mxf|ts)$/i;
const SPRITE_COLS = 10;
const SPRITE_W = 160;
const SPRITE_H = 90;

const BROWSER_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const BROWSER_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

/**
 * Why the original can't be streamed straight to a browser (null when it can).
 * Phones choke on 4K / very high bitrates too, so those get a light proxy as well.
 */
export function proxyReason(meta, ext = '') {
  const container = String(meta.container || '');
  const mp4Family = container.includes('mp4') || container.includes('mov');
  const webm = container.includes('webm') && /\.webm$/i.test(ext);
  if (!mp4Family && !webm) return `${ext.replace('.', '').toUpperCase() || 'this container'} doesn't play in browsers`;
  if (!BROWSER_VIDEO.includes(meta.videoCodec)) return `${meta.videoCodec || 'unknown'} video doesn't play in every browser`;
  if (meta.videoCodec === 'h264' && meta.pixFmt && !/^yuvj?420p$/.test(meta.pixFmt)) return `${meta.pixFmt} H.264 isn't supported by browsers`;
  if (meta.hasAudio && !BROWSER_AUDIO.includes(meta.audioCodec)) return `${meta.audioCodec || 'unknown'} audio doesn't play in browsers`;
  if (meta.width * meta.height > 1920 * 1088) return 'larger than 1080p — a lighter copy previews smoothly';
  if (meta.bitRate > 25e6) return 'very high bitrate — a lighter copy previews smoothly';
  return null;
}

/**
 * Storyboard layout: roughly one frame per second, 8–60 frames, 10 per row. Tiles are always
 * 16:9 (portrait shots are pillarboxed) so they line up with the 16:9 cards in the UI.
 */
export function spriteLayout(duration) {
  const count = Math.min(60, Math.max(8, Math.ceil(duration || 0)));
  return { count, cols: Math.min(SPRITE_COLS, count), rows: Math.ceil(count / SPRITE_COLS), w: SPRITE_W, h: SPRITE_H, interval: (duration || 0) / count };
}

export function createLibrary({ dir, onChange = () => {} }) {
  const incoming = path.join(dir, '.incoming');
  fsSync.mkdirSync(incoming, { recursive: true });
  const assets = new Map();
  const isAssetId = (s) => typeof s === 'string' && /^[a-f0-9]{16}$/.test(s);
  const assetDir = (id) => path.join(dir, id);
  const file = (id, name) => path.join(assetDir(id), name);
  const save = async (a) => {
    await fs.writeFile(file(a.id, 'meta.json.tmp'), JSON.stringify(a, null, 2));
    await fs.rename(file(a.id, 'meta.json.tmp'), file(a.id, 'meta.json'));
  };
  const changed = (a) => onChange({ type: 'asset', asset: toPublic(a) });

  function toPublic(a) {
    const v = a.updatedAt;
    return {
      id: a.id,
      name: a.name,
      size: a.size,
      createdAt: a.createdAt,
      duration: a.duration,
      width: a.width,
      height: a.height,
      hasAudio: a.hasAudio,
      videoCodec: a.videoCodec,
      audioCodec: a.audioCodec,
      status: a.status,
      preview: a.preview,
      thumbnail: `/api/library/${a.id}/thumb?v=${v}`,
      sprite: a.preview.sprite ? { url: `/api/library/${a.id}/sprite?v=${v}`, ...a.preview.sprite } : null,
      streamUrl: a.preview.proxy === 'ready' || !a.preview.proxyReason ? `/api/library/${a.id}/stream?v=${v}` : null,
      downloadUrl: `/api/library/${a.id}/download`,
    };
  }

  // ---- background preview queue ----------------------------------------------
  const queue = [];
  let working = false;
  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    if (!working) drain();
  }
  async function drain() {
    working = true;
    while (queue.length) {
      const a = assets.get(queue.shift());
      if (!a) continue;
      try {
        await makePreviews(a);
      } catch (err) {
        console.error(`[library ${a.id}]`, err.message);
      }
    }
    working = false;
  }

  async function update(a, patch) {
    if (!assets.has(a.id)) return; // deleted while working
    Object.assign(a, patch, { updatedAt: Date.now() });
    await save(a).catch(() => {});
    changed(a);
  }

  async function makePreviews(a) {
    const src = file(a.id, a.file);
    if (!a.preview.sprite) {
      await update(a, { preview: { ...a.preview, step: 'storyboard' } });
      const layout = spriteLayout(a.duration);
      const ok = await makeSprite(src, file(a.id, 'sprite.jpg'), layout, a.id);
      await update(a, { preview: { ...a.preview, sprite: ok ? layout : null, step: null } });
    }
    if (a.preview.proxyReason && a.preview.proxy !== 'ready') {
      await update(a, { preview: { ...a.preview, proxy: 'encoding', progress: 0 } });
      const ok = await makeProxy(src, file(a.id, 'proxy.mp4'), a.duration, (p) => {
        if (Math.abs(p - (a.preview.progress || 0)) < 0.02) return;
        a.preview = { ...a.preview, progress: p };
        changed(a);
      });
      await update(a, { preview: { ...a.preview, proxy: ok ? 'ready' : 'failed', progress: ok ? 1 : 0 } });
    }
    await update(a, { status: 'ready' });
  }

  async function makeSprite(src, out, { count, cols, rows, w, h, interval }, id) {
    const work = path.join(incoming, `sprite-${id}`);
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    try {
      let last = null;
      for (let i = 0; i < count; i++) {
        const frame = path.join(work, `f${String(i).padStart(3, '0')}.jpg`);
        // Input seeking jumps to the nearest keyframe — fast even on multi-GB files.
        const r = await run('ffmpeg', [
          '-v', 'error', '-y', '-ss', ((i + 0.5) * interval).toFixed(2), '-i', src,
          '-frames:v', '1', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1`, '-q:v', '6', frame,
        ]);
        if (r.code === 0 && (await exists(frame))) last = frame;
        else if (last) await fs.copyFile(last, frame);
        else return false;
      }
      const r = await run('ffmpeg', [
        '-v', 'error', '-y', '-i', path.join(work, 'f%03d.jpg'),
        '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', out,
      ]);
      return r.code === 0;
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  async function makeProxy(src, out, duration, onProgress) {
    const tmp = `${out}.part.mp4`;
    const r = await run('ffmpeg', [
      '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', tmp,
    ], {
      onLine: (line) => {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && duration) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / duration));
      },
    });
    if (r.code !== 0) {
      console.error('[library] proxy failed:', tail(r.stderr, 5));
      await fs.rm(tmp, { force: true });
      return false;
    }
    await fs.rename(tmp, out);
    return true;
  }

  // ---- public API -------------------------------------------------------------
  return {
    incoming,
    isAssetId,

    /** Read every asset from disk and resume unfinished previews (after a restart). */
    async load() {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || !isAssetId(e.name)) continue;
        try {
          const a = JSON.parse(await fs.readFile(file(e.name, 'meta.json'), 'utf8'));
          assets.set(a.id, a);
          if (a.status !== 'ready') enqueue(a.id);
        } catch {
          /* half-written asset from a crash — leave it for manual cleanup */
        }
      }
      // Storyboard scratch dirs from an interrupted run.
      for (const f of await fs.readdir(incoming)) if (f.startsWith('sprite-')) await fs.rm(path.join(incoming, f), { recursive: true, force: true });
    },

    list: () => [...assets.values()].sort((x, y) => y.createdAt - x.createdAt).map(toPublic),
    get: (id) => (isAssetId(id) ? assets.get(id) || null : null),
    toPublic,
    sourcePath: (id) => file(id, assets.get(id).file),
    thumbPath: (id) => file(id, 'thumb.jpg'),
    spritePath: (id) => file(id, 'sprite.jpg'),
    /** What the browser should play: the proxy when one was needed, else the original. */
    streamPath(id) {
      const a = assets.get(id);
      if (a.preview.proxy === 'ready') return file(id, 'proxy.mp4');
      return a.preview.proxyReason ? null : file(id, a.file);
    },
    cacheDir: (id) => path.join(assetDir(id), 'cache'),
    totalSize: () => [...assets.values()].reduce((s, a) => s + a.size, 0),

    /**
     * Move a finished upload into the library. Probes it (rejects non-video), grabs a poster
     * frame, and queues the storyboard + proxy. Returns the public asset.
     */
    async ingest(uploadedPath, { name, size }) {
      const id = crypto.randomBytes(8).toString('hex');
      const ext = (path.extname(name) || '.mp4').toLowerCase();
      let meta;
      try {
        meta = await probe(uploadedPath);
      } catch (err) {
        throw new PipelineError(`${name} isn't a readable video.`, { detail: err.detail || err.message });
      }
      if (!meta.hasVideo || !meta.duration) throw new PipelineError(`${name} has no video stream.`);

      await fs.mkdir(assetDir(id), { recursive: true });
      const dest = file(id, `source${ext}`);
      try {
        await fs.rename(uploadedPath, dest);
      } catch {
        await fs.copyFile(uploadedPath, dest);
        await fs.rm(uploadedPath, { force: true });
      }
      await run('ffmpeg', [
        '-v', 'error', '-y', '-ss', String(Math.min(1, meta.duration / 3)), '-i', dest,
        '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', file(id, 'thumb.jpg'),
      ]).catch(() => null);

      const reason = proxyReason(meta, ext);
      const a = {
        id,
        name,
        file: `source${ext}`,
        size,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...meta,
        status: 'processing',
        preview: { sprite: null, proxyReason: reason, proxy: reason ? 'pending' : 'none', progress: 0, step: null },
      };
      await save(a);
      assets.set(id, a);
      changed(a);
      enqueue(id);
      return toPublic(a);
    },

    async rename(id, name) {
      const a = assets.get(id);
      await update(a, { name });
      return toPublic(a);
    },

    async remove(id) {
      assets.delete(id);
      const i = queue.indexOf(id);
      if (i >= 0) queue.splice(i, 1);
      await fs.rm(assetDir(id), { recursive: true, force: true });
      onChange({ type: 'removed', id });
    },
  };
}

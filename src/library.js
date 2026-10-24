import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { run, probe, exists, tail, PipelineError } from './util.js';
import { measureQuality } from './quality.js';
import { scanMusic, MUSIC_VERSION } from './musicscan.js';

// v2: measured as 8-bit (10-bit phone footage used to read as over-exposed).
const QUALITY_VERSION = 2;

/**
 * Media library: every uploaded video (or music track) lives here once and can be used by any
 * number of projects.
 *
 *   library/<assetId>/source.<ext>   the original file, untouched
 *   library/<assetId>/meta.json      name, size, probe data, preview status, AI scan results
 *   library/<assetId>/thumb.jpg      poster frame (a waveform for music)
 *   library/<assetId>/sprite.jpg     storyboard strip for hover-scrubbing
 *   library/<assetId>/sheet.jpg      larger frame grid that Claude looks at to describe the clip
 *   library/<assetId>/proxy.mp4      small H.264 copy, only when the browser can't play the original
 *   library/<assetId>/cache/…        transcripts, analysis, seekable/blur/voice renders (shared by projects)
 *
 * Previews are made in two background queues so big uploads finish instantly:
 *   - fast: storyboard + contact sheet (a few seconds per clip) → the clip is "ready" and Claude can
 *     scan it straight away;
 *   - heavy: shrinking 4K to 1080p and browser preview copies (full re-encodes). These wait while a
 *     video is rendering, so they never slow a render down or swap a file a render is reading.
 * Every ffmpeg call has a time limit, so one broken file can't freeze the queue.
 */

export const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|mpg|mpeg|3gp|wmv|flv|mxf|ts)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aif|aiff)$/i;
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

/**
 * Footage above 1080p or ~16 Mbit/s is worth shrinking: ClipForge never outputs more than 1080p, so
 * the extra pixels only cost disk space and slow down transcription and rendering.
 */
export function shouldShrink(meta, size) {
  const mbps = meta.duration ? (size * 8) / meta.duration / 1e6 : 0;
  return Math.max(meta.width || 0, meta.height || 0) > 1920 * 1.05 || mbps > 16;
}

/**
 * Contact sheet for AI scanning: a frame every ~3 s (4–16 frames), 4 per row, 384×216 tiles.
 * `times` says which source second each tile shows, in reading order.
 */
export function sheetLayout(duration) {
  const count = Math.min(16, Math.max(4, Math.round((duration || 0) / 3)));
  const times = Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * (duration || 0) / count) * 10) / 10);
  return { count, cols: 4, rows: Math.ceil(count / 4), w: 384, h: 216, times };
}

const FRAME_TIMEOUT = 2 * 60_000;
/** A full re-encode gets 30 min plus 20× the clip's length (2-core machines encode 4K slowly). */
const encodeTimeout = (duration) => 30 * 60_000 + (duration || 0) * 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLibrary({ dir, onChange = () => {}, onReady = () => {}, isRendering = () => false, onIngest = () => {} }) {
  const incoming = path.join(dir, '.incoming');
  fsSync.mkdirSync(incoming, { recursive: true });
  const settingsFile = path.join(dir, '.library.json');
  let settings = { shrinkLarge: true, extractAudio: false };
  try {
    settings = { ...settings, ...JSON.parse(fsSync.readFileSync(settingsFile, 'utf8')) };
  } catch {
    /* defaults */
  }
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
      kind: a.kind || 'video',
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
      tags: a.tags || {},
      source: a.source || null,
      ai: a.ai || { status: 'none' },
      quality: a.quality || null,
      sounds: a.sounds || null,
      music: a.music && !a.music.error ? a.music : null,
      musicTags: a.musicTags || null,
      embedded: a.embedded || null,
      styleRef: Boolean(a.styleRef),
      folder: a.folder || null,
      shrunk: a.shrunk && a.shrunk !== 'failed' ? a.shrunk.from : null,
      thumbnail: `/api/library/${a.id}/thumb?v=${v}`,
      sprite: a.preview.sprite ? { url: `/api/library/${a.id}/sprite?v=${v}`, ...a.preview.sprite } : null,
      streamUrl: a.preview.proxy === 'ready' || !a.preview.proxyReason ? `/api/library/${a.id}/stream?v=${v}` : null,
      downloadUrl: `/api/library/${a.id}/download`,
    };
  }

  // ---- background preview queues ---------------------------------------------
  const queue = []; // fast: storyboard + contact sheet
  const heavy = []; // re-encodes: shrink + proxy
  let working = false;
  let heavyWorking = false;
  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    if (!working) drain();
  }
  function enqueueHeavy(id) {
    if (!heavy.includes(id)) heavy.push(id);
    if (!heavyWorking) drainHeavy();
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
  async function drainHeavy() {
    heavyWorking = true;
    while (heavy.length) {
      while (isRendering() || queue.length) await sleep(5_000); // renders and storyboards first
      const a = assets.get(heavy.shift());
      if (!a) continue;
      try {
        await makeHeavy(a);
      } catch (err) {
        console.error(`[library ${a.id}]`, err.message);
      }
    }
    heavyWorking = false;
  }

  async function update(a, patch) {
    if (!assets.has(a.id)) return; // deleted while working
    Object.assign(a, patch, { updatedAt: Date.now() });
    await save(a).catch(() => {});
    changed(a);
  }

  const needsHeavy = (a) =>
    a.kind === 'audio' ? a.music?.v !== MUSIC_VERSION :
    ((settings.shrinkLarge && !a.shrunk && shouldShrink(a, a.size)) ||
      (a.preview.proxyReason && !['ready', 'failed'].includes(a.preview.proxy)) ||
      a.quality?.v !== QUALITY_VERSION);

  async function makePreviews(a) {
    const src = file(a.id, a.file);
    if (a.kind === 'audio') {
      await update(a, { status: 'ready' });
      if (needsHeavy(a)) enqueueHeavy(a.id); // "listen" to it: tempo, energy, drop
      return onReady(a);
    }
    if (!a.preview.sprite) {
      await update(a, { preview: { ...a.preview, step: 'storyboard' } });
      const layout = spriteLayout(a.duration);
      const ok = await makeSprite(src, file(a.id, 'sprite.jpg'), layout, a.id);
      await update(a, { preview: { ...a.preview, sprite: ok ? layout : null, step: null } });
    }
    if (!a.preview.sheet) await makeSheet(a);
    await update(a, { status: 'ready' });
    if (!assets.has(a.id)) return;
    onReady(a);
    if (needsHeavy(a)) enqueueHeavy(a.id);
  }

  async function makeHeavy(a) {
    if (a.kind === 'audio') {
      try {
        await update(a, { music: (await scanMusic(file(a.id, a.file))) || { v: MUSIC_VERSION, error: 'too short' } });
      } catch (err) {
        await update(a, { music: { v: MUSIC_VERSION, error: err.message } });
      }
      return onReady(a); // now the AI index can tag its genre and mood
    }
    if (settings.shrinkLarge && !a.shrunk && shouldShrink(a, a.size)) await shrink(a);
    if (!assets.has(a.id)) return;
    if (a.preview.proxyReason && !['ready', 'failed'].includes(a.preview.proxy)) {
      await update(a, { preview: { ...a.preview, proxy: 'encoding', progress: 0 } });
      const ok = await makeProxy(file(a.id, a.file), file(a.id, 'proxy.mp4'), a.duration, (p) => {
        if (Math.abs(p - (a.preview.progress || 0)) < 0.02) return;
        a.preview = { ...a.preview, progress: p };
        changed(a);
      });
      await update(a, { preview: { ...a.preview, proxy: ok ? 'ready' : 'failed', progress: ok ? 1 : 0 } });
    }
    // Quality score (sharpness, exposure, shake, sound level) — so bad clips are never picked.
    if (a.quality?.v !== QUALITY_VERSION && assets.has(a.id)) {
      try {
        const quality = await measureQuality(file(a.id, a.file), { hasAudio: a.hasAudio, work: file(a.id, '.quality') });
        await update(a, { quality: { ...quality, v: QUALITY_VERSION } });
      } catch (err) {
        await update(a, { quality: { score: null, flags: [], error: err.message, measuredAt: Date.now(), v: QUALITY_VERSION } });
      }
    }
  }

  /** Re-encode to ≤1080p H.264 with a keyframe every second and replace the stored file. */
  async function shrink(a) {
    const src = file(a.id, a.file);
    const tmp = file(a.id, 'shrink.part.mp4');
    await update(a, { preview: { ...a.preview, step: 'shrinking', progress: 0 } });
    const r = await run('ffmpeg', [
      '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '30',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp,
    ], {
      timeoutMs: encodeTimeout(a.duration),
      onLine: (line) => {
        const m = line.match(/^out_time_us=(\d+)/);
        if (!m || !a.duration) return;
        const p = Math.min(0.99, Number(m[1]) / 1e6 / a.duration);
        if (p - (a.preview.progress || 0) < 0.02) return;
        a.preview = { ...a.preview, progress: p };
        changed(a);
      },
    });
    if (r.code !== 0 || !assets.has(a.id)) {
      await fs.rm(tmp, { force: true });
      if (r.code !== 0) console.error(`[library ${a.id}] shrink failed — keeping the original:`, tail(r.stderr, 3));
      return update(a, { shrunk: 'failed', preview: { ...a.preview, step: null, progress: 0 } });
    }
    // Never swap the file under a render that is reading it.
    while (isRendering() && assets.has(a.id)) await sleep(10_000);
    if (!assets.has(a.id)) return fs.rm(tmp, { force: true });
    const meta = await probe(tmp);
    const size = (await fs.stat(tmp)).size;
    await fs.rename(tmp, file(a.id, 'source.mp4'));
    if (a.file !== 'source.mp4') await fs.rm(src, { force: true });
    // The new file plays in every browser, so no preview copy is needed any more.
    await update(a, {
      ...meta,
      file: 'source.mp4',
      size,
      shrunk: { from: { width: a.width, height: a.height, size: a.size } },
      preview: { ...a.preview, proxyReason: null, proxy: 'none', step: null, progress: 0 },
    });
  }

  const makeSprite = (src, out, { count, cols, rows, w, h, interval }, id) =>
    makeGrid(src, out, Array.from({ length: count }, (_, i) => (i + 0.5) * interval), { cols, rows, w, h, q: 6 }, `sprite-${id}`);

  async function makeSheet(a) {
    const layout = sheetLayout(a.duration);
    const ok = await makeGrid(file(a.id, a.file), file(a.id, 'sheet.jpg'), layout.times, { ...layout, q: 4 }, `sheet-${a.id}`);
    await update(a, { preview: { ...a.preview, sheet: ok ? layout : null } });
    return ok;
  }

  /** Grab one frame per time (16:9 tiles, pillarboxed) and tile them into one JPEG. */
  async function makeGrid(src, out, times, { cols, rows, w, h, q }, scratch) {
    const work = path.join(incoming, scratch);
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    try {
      let last = null;
      for (let i = 0; i < times.length; i++) {
        const frame = path.join(work, `f${String(i).padStart(3, '0')}.jpg`);
        // Input seeking jumps to the nearest keyframe — fast even on multi-GB files.
        const r = await run('ffmpeg', [
          '-v', 'error', '-y', '-ss', times[i].toFixed(2), '-i', src,
          '-frames:v', '1', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1`, '-q:v', String(q), frame,
        ], { timeoutMs: FRAME_TIMEOUT });
        if (r.code === 0 && (await exists(frame))) last = frame;
        else if (last) await fs.copyFile(last, frame);
        else return false;
      }
      const r = await run('ffmpeg', [
        '-v', 'error', '-y', '-i', path.join(work, 'f%03d.jpg'),
        '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', String(q), out,
      ], { timeoutMs: FRAME_TIMEOUT });
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
      timeoutMs: encodeTimeout(duration),
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
          if (a.preview?.proxy === 'encoding') a.preview.proxy = 'pending'; // interrupted by a restart
          if (a.preview?.step === 'shrinking') a.preview = { ...a.preview, step: null, progress: 0 };
          if (a.status !== 'ready') enqueue(a.id);
          else if (needsHeavy(a)) enqueueHeavy(a.id);
        } catch {
          /* half-written asset from a crash — leave it for manual cleanup */
        }
      }
      // Storyboard / contact-sheet scratch dirs from an interrupted run.
      for (const f of await fs.readdir(incoming)) {
        if (/^(sprite|sheet)-/.test(f)) await fs.rm(path.join(incoming, f), { recursive: true, force: true });
      }
    },

    settings: () => ({ ...settings }),
    async setSettings(patch) {
      settings = { ...settings, ...patch };
      await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
      // Turned "Save space" on: shrink what's already there, in the background.
      if (settings.shrinkLarge) for (const a of assets.values()) if (a.status === 'ready' && needsHeavy(a)) enqueueHeavy(a.id);
      return { ...settings };
    },
    /** Background work waiting (for the "working on…" line). */
    activity: () => ({ previews: queue.length + (working ? 1 : 0), heavy: heavy.length + (heavyWorking ? 1 : 0), paused: heavy.length > 0 && isRendering() }),
    list: () => [...assets.values()].sort((x, y) => y.createdAt - x.createdAt).map(toPublic),
    get: (id) => (isAssetId(id) ? assets.get(id) || null : null),
    toPublic,
    sourcePath: (id) => file(id, assets.get(id).file),
    thumbPath: (id) => file(id, 'thumb.jpg'),
    spritePath: (id) => file(id, 'sprite.jpg'),
    sheetPath: (id) => file(id, 'sheet.jpg'),
    /** Make the AI contact sheet for assets uploaded before sheets existed. */
    async ensureSheet(id) {
      const a = assets.get(id);
      if (!a || a.kind === 'audio') return false;
      return a.preview.sheet ? true : makeSheet(a);
    },
    async setAI(id, ai) {
      const a = assets.get(id);
      if (a) await update(a, { ai });
    },
    /** Store extra analysis fields (sound tags, embedding marker…). */
    async setFields(id, patch) {
      const a = assets.get(id);
      if (a) await update(a, patch);
    },
    assetDir,
    /** Already imported? Matches the cloud file id, else path + size. */
    findBySource(src) {
      return [...assets.values()].find((a) =>
        a.source && a.source.remote === src.remote &&
        ((src.id && a.source.id === src.id) || (a.source.path === src.path && a.size === src.size))) || null;
    },
    /** What the browser should play: the proxy when one was needed, else the original. */
    streamPath(id) {
      const a = assets.get(id);
      if (a.kind === 'audio') return file(id, a.file);
      if (a.preview.proxy === 'ready') return file(id, 'proxy.mp4');
      return a.preview.proxyReason ? null : file(id, a.file);
    },
    cacheDir: (id) => path.join(assetDir(id), 'cache'),
    totalSize: () => [...assets.values()].reduce((s, a) => s + a.size, 0),

    /**
     * Move a finished upload into the library. Probes it (rejects anything that isn't video or
     * music), grabs a poster frame or waveform, and queues the storyboard + proxy. Returns the
     * public asset. `source` records where an imported file came from (cloud remote + path).
     */
    async ingest(uploadedPath, { name, size, source = null }) {
      const id = crypto.randomBytes(8).toString('hex');
      const ext = (path.extname(name) || '.mp4').toLowerCase();
      let meta;
      try {
        meta = await probe(uploadedPath);
      } catch (err) {
        throw new PipelineError(`${name} isn't a readable video or audio file.`, { detail: err.detail || err.message });
      }
      const kind = meta.hasVideo ? 'video' : meta.hasAudio ? 'audio' : null;
      if (!kind || !meta.duration) throw new PipelineError(`${name} has no video or audio in it.`);

      await fs.mkdir(assetDir(id), { recursive: true });
      const dest = file(id, `source${ext}`);
      try {
        await fs.rename(uploadedPath, dest);
      } catch {
        await fs.copyFile(uploadedPath, dest);
        await fs.rm(uploadedPath, { force: true });
      }
      const thumbArgs = kind === 'video'
        ? ['-ss', String(Math.min(1, meta.duration / 3)), '-i', dest, '-frames:v', '1', '-vf', 'scale=480:-2']
        : ['-i', dest, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=480x270:colors=#9b85ff', '-frames:v', '1'];
      await run('ffmpeg', ['-v', 'error', '-y', ...thumbArgs, '-q:v', '4', file(id, 'thumb.jpg')], { timeoutMs: FRAME_TIMEOUT }).catch(() => null);

      const reason = kind === 'video' ? proxyReason(meta, ext) : null;
      const a = {
        id,
        kind,
        name,
        file: `source${ext}`,
        size,
        source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...meta,
        ai: { status: 'none' },
        status: 'processing',
        preview: { sprite: null, proxyReason: reason, proxy: reason ? 'pending' : 'none', progress: 0, step: null },
      };
      await save(a);
      assets.set(id, a);
      changed(a);
      enqueue(id);
      onIngest(toPublic(a));
      return toPublic(a);
    },

    async rename(id, name) {
      const a = assets.get(id);
      await update(a, { name });
      return toPublic(a);
    },

    async remove(id) {
      assets.delete(id);
      for (const q of [queue, heavy]) {
        const i = q.indexOf(id);
        if (i >= 0) q.splice(i, 1);
      }
      await fs.rm(assetDir(id), { recursive: true, force: true });
      onChange({ type: 'removed', id });
    },
  };
}

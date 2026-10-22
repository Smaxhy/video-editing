import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { transcribe, WHISPER_MODELS, ENGINES } from './transcriber.js';
import { analyzeClip, isolateVoice, cutoutImage } from './analysis.js';
import { detectTools, onPath, OPTIONAL_TOOLS } from './tools.js';
import { generateEditPlans, GOALS, LENGTHS } from './editor.js';
import {
  writeProject, renderProject, makeBlurBackground, aspectMismatch, ensureSeekable,
  FORMATS, CAPTION_STYLES, FRAMINGS,
} from './renderer.js';
import { compressVideo, SIZE_PRESETS, RENDER_QUALITY } from './compress.js';
import { run, exists, PipelineError } from './util.js';
import { createAuth } from './auth.js';
import { createLibrary, VIDEO_EXT } from './library.js';
import { Server as TusServer } from '@tus/server';
import { FileStore } from '@tus/file-store';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = {
  uploads: path.join(ROOT, 'uploads'),
  workspace: path.join(ROOT, 'workspace'),
  output: path.join(ROOT, 'output'),
  library: process.env.LIBRARY_DIR ? path.resolve(process.env.LIBRARY_DIR) : path.join(ROOT, 'library'),
  public: path.join(ROOT, 'public'),
};
const PORT = Number(process.env.PORT || 3000);
// `--lan` (npm run start:lan) listens on every interface so phones on your Wi-Fi/Tailscale can connect.
const HOST = process.argv.includes('--lan') ? '0.0.0.0' : process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
// No size cap by default — uploads are resumable and only limited by free disk space.
const MAX_UPLOAD_BYTES = process.env.MAX_UPLOAD_MB ? Number(process.env.MAX_UPLOAD_MB) * 1024 * 1024 : 0;
const DISK_HEADROOM = 2 * 1024 ** 3; // keep 2 GB free for transcodes and renders
const MAX_VARIANTS = 8;

for (const d of [DIRS.uploads, DIRS.workspace, DIRS.output, DIRS.library]) fsSync.mkdirSync(d, { recursive: true });

async function diskFree(dir) {
  try {
    const s = await fs.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { free: null, total: null };
  }
}

// Library SSE listeners get every asset change (upload finished, storyboard ready, proxy progress…).
const libraryListeners = new Set();
const library = createLibrary({
  dir: DIRS.library,
  onChange: (evt) => {
    const data = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of libraryListeners) res.write(data);
  },
});
await library.load();

// ---------------------------------------------------------------------------
// Job store. A job = one project (a set of uploaded clips); each POST /api/edit
// runs the pipeline on it and replaces the previous outputs.
// Clip manifests and results live on disk so a project survives a server restart.
// ---------------------------------------------------------------------------

const jobs = new Map();
const isId = (s) => typeof s === 'string' && /^[a-z0-9-]{1,64}$/i.test(s);
const resultFile = (id) => path.join(DIRS.output, id, 'result.json');

function newJob(id = crypto.randomUUID().slice(0, 12), name = '') {
  const job = {
    id,
    name,
    createdAt: Date.now(),
    clips: [],
    nextClip: 1,
    state: 'idle', // idle | running | done | error
    steps: freshSteps(),
    message: '',
    progress: 0,
    error: null,
    result: null,
    listeners: new Set(),
    abort: null,
    lastProgressSent: -1,
  };
  jobs.set(id, job);
  return job;
}

function freshSteps() {
  return {
    transcribe: { status: 'pending', message: '' },
    plan: { status: 'pending', message: '' },
    render: { status: 'pending', message: '' },
  };
}

async function getJob(id) {
  if (!isId(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  // Rehydrate from disk after a restart.
  const manifest = path.join(DIRS.uploads, id, 'clips.json');
  if (!(await exists(manifest))) return null;
  const job = newJob(id);
  const saved = JSON.parse(await fs.readFile(manifest, 'utf8'));
  job.clips = saved.clips
    .filter((c) => !c.assetId || library.get(c.assetId)) // asset deleted while the server was down
    .map((c) => ({ ...c, path: c.assetId ? library.sourcePath(c.assetId) : path.join(DIRS.uploads, id, c.file) }));
  job.nextClip = saved.nextClip;
  job.logo = saved.logo || null;
  job.name = saved.name || '';
  job.createdAt = saved.createdAt || (await fs.stat(manifest)).mtimeMs;
  if (await exists(resultFile(id))) {
    job.result = JSON.parse(await fs.readFile(resultFile(id), 'utf8'));
    job.state = 'done';
    job.progress = 1;
    for (const s of Object.values(job.steps)) s.status = 'done';
  }
  return job;
}

async function saveManifest(job) {
  await fs.mkdir(path.join(DIRS.uploads, job.id), { recursive: true });
  await fs.writeFile(
    path.join(DIRS.uploads, job.id, 'clips.json'),
    JSON.stringify(
      {
        name: job.name || '',
        createdAt: job.createdAt,
        clips: job.clips.map(({ path: _p, ...c }) => c),
        nextClip: job.nextClip,
        logo: job.logo || null,
      },
      null,
      2,
    ),
  );
}

/** Every project on disk (newest first), loading each into memory once. */
async function allProjects() {
  const ids = (await fs.readdir(DIRS.uploads, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && isId(e.name))
    .map((e) => e.name);
  const list = (await Promise.all(ids.map((id) => getJob(id).catch(() => null)))).filter(Boolean);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

const projectName = (job) => job.name || job.result?.title || job.clips[0]?.name?.replace(/\.[^.]+$/, '') || 'Untitled project';

const publicProject = (job) => ({
  id: job.id,
  name: projectName(job),
  createdAt: job.createdAt,
  clips: job.clips.length,
  duration: job.clips.reduce((s, c) => s + (c.duration || 0), 0),
  thumbnail: job.clips[0] ? publicClip(job.id, job.clips[0]).thumbnail : null,
  state: job.state,
  videos: job.result?.variants?.length || 0,
});

function snapshot(job) {
  return {
    jobId: job.id,
    state: job.state,
    steps: job.steps,
    message: job.message,
    progress: job.progress,
    error: job.error,
    result: job.result,
  };
}

function emit(job) {
  const data = `data: ${JSON.stringify(snapshot(job))}\n\n`;
  for (const res of job.listeners) res.write(data);
}

function setStep(job, step, status, message, progress) {
  job.steps[step] = { status, message: message ?? job.steps[step].message };
  if (message) job.message = message;
  if (progress != null) job.progress = progress;
  emit(job);
}

const publicLogo = (job) =>
  job.logo ? { url: `/api/logo/${job.id}?v=${job.logo.at}`, cutout: job.logo.cutout, note: job.logo.note || null } : null;

function publicClip(jobId, c) {
  const asset = c.assetId ? library.get(c.assetId) : null;
  const pub = asset ? library.toPublic(asset) : null;
  return {
    id: c.id,
    assetId: c.assetId || null,
    name: pub?.name || c.name,
    size: c.size,
    duration: c.duration,
    width: c.width,
    height: c.height,
    hasAudio: c.hasAudio,
    thumbnail: pub?.thumbnail || `/api/thumb/${jobId}/${c.id}`,
    sprite: pub?.sprite || null,
    // Clips uploaded before the library existed stream straight from the project folder.
    streamUrl: pub ? pub.streamUrl : `/api/clipfile/${jobId}/${c.id}`,
  };
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Collapse notes that only differ by clip name: "X failed for a.mp4" + "… b.mp4" → one line. */
function mergeNotes(notes, names) {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const re = escaped.length ? new RegExp(escaped.join('|'), 'g') : null;
  const groups = new Map();
  for (const n of notes) {
    const found = re ? n.match(re) || [] : [];
    const key = re ? n.replace(re, '\u0000') : n;
    if (!groups.has(key)) groups.set(key, new Set());
    found.forEach((f) => groups.get(key).add(f));
  }
  return [...groups].map(([key, set]) => key.replace('\u0000', [...set].join(', ')).replace(/\u0000/g, ''));
}

const lengthLabel = (l) => (l === 'full' ? 'Full' : `${l}s`);

// ---------------------------------------------------------------------------
// Pipeline: transcribe once → one Claude call plans every length → render each
// length × format with HyperFrames → compress.
// ---------------------------------------------------------------------------

async function runPipeline(job, { prompt, clipIds, settings, reusePlan }) {
  const ws = path.join(DIRS.workspace, job.id);
  const outDir = path.join(DIRS.output, job.id);
  const signal = job.abort.signal;
  const clips = clipIds
    .map((id) => job.clips.find((c) => c.id === id))
    .map((c) => (c.assetId && library.get(c.assetId) ? { ...c, name: library.get(c.assetId).name } : c)); // follow renames
  const formats = settings.formats.map((key) => ({ key, ...FORMATS[key] }));
  // Library clips keep transcripts, analysis and pre-renders next to the asset, so every
  // project that reuses a clip skips that work. Legacy clips cache per project.
  const cache = (c, sub, ext) =>
    c.assetId ? path.join(library.cacheDir(c.assetId), sub, `source${ext}`) : path.join(ws, sub, `${c.id}${ext}`);
  const checkAbort = () => {
    if (signal.aborted) throw new PipelineError('Cancelled.');
  };

  // 1. Transcribe + analyze (0 → 30%) -----------------------------------------
  const tools = await detectTools();
  const notes = [];
  const transcripts = {};
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const label = `Transcribing clip ${i + 1}/${clips.length} (${c.name})`;
    setStep(job, 'transcribe', 'active', `${label}…`, (i / clips.length) * 0.3);
    transcripts[c.id] = await transcribe(c.path, {
      model: settings.whisperModel,
      engine: settings.engine,
      tools,
      label: c.name,
      anyCached: reusePlan,
      outDir: c.assetId ? path.join(library.cacheDir(c.assetId), 'transcripts') : path.join(ws, 'transcripts', c.id),
      signal,
      onProgress: (p) => {
        const overall = ((i + p) / clips.length) * 0.3;
        if (Math.abs(overall - job.lastProgressSent) >= 0.01) {
          job.lastProgressSent = overall;
          setStep(job, 'transcribe', 'active', `${label}… ${Math.round(p * 100)}%`, overall * 0.85);
        }
      },
    });
    if (transcripts[c.id].note && transcripts[c.id].engine) notes.push(transcripts[c.id].note);
    checkAbort();
  }

  // Footage analysis: silent ranges (auto-editor / FFmpeg), shot changes (PySceneDetect),
  // face positions (OpenCV, only needed for face-tracked framing). Cached per clip.
  const features = { silence: settings.silence, shots: settings.shots && tools.sceneDetect, faces: settings.framing === 'face' && tools.faces };
  if (settings.framing === 'face' && !tools.faces) notes.push('Face tracking needs OpenCV (pip install "opencv-python-headless<5") — used centre crop.');
  const analysis = {};
  if (features.silence || features.shots || features.faces) {
    for (const [i, c] of clips.entries()) {
      setStep(job, 'transcribe', 'active', `Analyzing footage ${i + 1}/${clips.length} (${c.name})…`, 0.26 + (i / clips.length) * 0.04);
      analysis[c.id] = await analyzeClip(c, { cacheFile: cache(c, 'analysis', '.json'), features, tools, signal });
      notes.push(...analysis[c.id].notes);
      checkAbort();
    }
  }
  await fs.writeFile(path.join(ws, 'transcripts.json'), JSON.stringify(transcripts, null, 2));
  const engines = [...new Set(Object.values(transcripts).map((t) => t.engine).filter(Boolean))];
  setStep(job, 'transcribe', 'done', `Transcribed${engines.length ? ` with ${engines.join(' + ')}` : ''} and analyzed ${clips.length} clip${clips.length > 1 ? 's' : ''}.`, 0.3);

  // 2. Plan every version in one claude -p call (30 → 38%) -------------------
  // reusePlan: output-only tweaks (format, captions, size…) skip Claude entirely.
  const planFile = path.join(ws, 'edit-plan.json');
  let planned = null;
  if (reusePlan) {
    const saved = JSON.parse(await fs.readFile(planFile, 'utf8').catch(() => 'null'));
    const versions = saved?.versions?.filter((v) => settings.lengths.includes(v.id)) || [];
    const usable = versions.length === settings.lengths.length &&
      versions.every((v) => v.plan.scenes.every((sc) => clips.some((c) => c.id === sc.clip)));
    if (!usable) {
      throw new PipelineError('No saved plan covers these lengths and clips.', {
        hint: 'Run a normal edit first (or pick lengths you already planned).',
      });
    }
    planned = { ...saved, versions, warnings: [] };
    setStep(job, 'plan', 'done', 'Reused the saved plan — no Claude call.', 0.38);
  } else {
    setStep(job, 'plan', 'active', 'Claude is planning the edit…', 0.32);
    const options = {
      goal: settings.goal,
      versions: settings.lengths,
      formats,
      captions: settings.captions,
      cta: settings.cta,
      brand: settings.brand,
    };
    planned = await generateEditPlans({
      clips: clips.map((c) => ({ ...c, transcript: transcripts[c.id], analysis: analysis[c.id] })),
      userPrompt: prompt,
      options,
      cwd: ws,
      signal,
      onStatus: (msg) => setStep(job, 'plan', 'active', msg),
    });
    await fs.writeFile(path.join(ws, 'claude-prompt.md'), planned.prompt);
    await fs.writeFile(path.join(ws, 'claude-response.txt'), planned.raw);
    await fs.writeFile(
      planFile,
      JSON.stringify({ title: planned.title, checklist: planned.checklist, versions: planned.versions }, null, 2),
    );
  }
  const n = planned.versions.length * formats.length;
  const planMsg = `${planned.versions.length} version${planned.versions.length > 1 ? 's' : ''} → ${n} video${n > 1 ? 's' : ''}`;
  setStep(job, 'plan', 'done', reusePlan ? `Reused saved plan (no Claude call): ${planMsg}.` : `Planned ${planMsg}.`, 0.38);
  checkAbort();

  // 3. Render + compress each version × format (38 → 100%) --------------------
  await fs.rm(outDir, { recursive: true, force: true }); // new run replaces old outputs (saves disk)
  await fs.mkdir(outDir, { recursive: true });

  // Make sure every source can be seeked frame-accurately (re-encodes only clips that need it).
  const renderPaths = {};
  for (const [k, c] of clips.entries()) {
    setStep(job, 'render', 'active', `Checking clip ${k + 1}/${clips.length} for smooth seeking…`, 0.38);
    renderPaths[c.id] = await ensureSeekable(c.path, cache(c, 'seekable', '.mp4'), { signal });
    checkAbort();
  }

  // Clean voice: isolate speech from music/noise with Demucs (cached per clip).
  const voicePaths = {};
  if (settings.cleanVoice) {
    const withAudio = clips.filter((c) => c.hasAudio);
    if (!tools.demucs) notes.push('Clean voice needs Demucs (pip install demucs) — kept the original audio.');
    for (const [k, c] of (tools.demucs ? withAudio : []).entries()) {
      setStep(job, 'render', 'active', `Isolating voice ${k + 1}/${withAudio.length} with Demucs (slow on CPU)…`, 0.38);
      try {
        voicePaths[c.id] = await isolateVoice(c.path, cache(c, 'voice', '.m4a'), { signal });
      } catch (err) {
        if (signal.aborted) throw new PipelineError('Cancelled.');
        notes.push(`Voice isolation failed for ${c.name} — kept the original audio. (${String(err.message).split('\n').pop()})`);
      }
    }
  }

  // Blurred backgrounds only for clips whose aspect doesn't match some output format.
  const blurPaths = {};
  if (settings.framing === 'blur') {
    const needs = clips.filter((c) => formats.some((f) => aspectMismatch(c, f.width, f.height)));
    for (const [k, c] of needs.entries()) {
      setStep(job, 'render', 'active', `Preparing blur-fill background ${k + 1}/${needs.length}…`, 0.38);
      blurPaths[c.id] = await makeBlurBackground(c.path, cache(c, 'blur', '.mp4'));
      checkAbort();
    }
  }

  const variants = [];
  const jobsList = planned.versions.flatMap((v) => formats.map((f) => ({ v, f })));
  for (const [k, { v, f }] of jobsList.entries()) {
    const id = `${v.id}-${f.key}`;
    const label = `${lengthLabel(v.id)} · ${f.label}`;
    const share = 0.62 / jobsList.length;
    const base = 0.38 + k * share;
    const prefix = jobsList.length > 1 ? `(${k + 1}/${jobsList.length}) ` : '';
    setStep(job, 'render', 'active', `${prefix}Composing ${label}…`, base);

    const projectDir = path.join(ws, 'project', id);
    const { total, captions } = await writeProject({
      projectDir,
      plan: { ...v.plan, title: planned.title },
      clips: clips.map((c) => ({
        ...c,
        path: renderPaths[c.id],
        blurPath: blurPaths[c.id] || null,
        voicePath: voicePaths[c.id] || null,
        faces: analysis[c.id]?.faces || null,
      })),
      transcripts,
      settings: {
        width: f.width,
        height: f.height,
        captions: settings.captions,
        framing: settings.framing,
        accent: settings.accent,
        logoPath: settings.useLogo && job.logo ? path.join(DIRS.uploads, job.id, job.logo.file) : null,
        watermark: settings.watermark,
      },
    });

    job.lastProgressSent = -1;
    const raw = path.join(outDir, `${id}.raw.mp4`);
    await renderProject({
      projectDir,
      outputPath: raw,
      quality: RENDER_QUALITY[settings.size],
      logPath: path.join(ws, `render-${id}.log`),
      signal,
      onProgress: (p) => {
        if (Math.abs(p - job.lastProgressSent) < 0.01) return;
        job.lastProgressSent = p;
        setStep(job, 'render', 'active', `${prefix}Rendering ${label}… ${Math.round(p * 100)}%`, base + p * share * 0.9);
      },
    });
    checkAbort();

    setStep(job, 'render', 'active', `${prefix}Compressing ${label}…`, base + share * 0.92);
    const fileName = `clipforge-${id}.mp4`;
    const size = await compressVideo(raw, path.join(outDir, fileName), settings.size, { signal, twoPass: tools.ffmpegNormalize });
    await fs.rm(projectDir, { recursive: true, force: true }); // composition is rebuilt on every run
    await run('ffmpeg', [
      '-v', 'error', '-y', '-ss', String(Math.min(1.2, total / 2)), '-i', path.join(outDir, fileName),
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', path.join(outDir, `${id}.jpg`),
    ]).catch(() => null);

    variants.push({
      id,
      length: v.id,
      format: f.key,
      label,
      width: f.width,
      height: f.height,
      duration: total,
      size,
      captions: captions.length,
      summary: v.plan.summary,
      file: fileName,
      previewUrl: `/api/download/${job.id}/${id}?inline=1&v=${Date.now()}`,
      posterUrl: `/api/poster/${job.id}/${id}?v=${Date.now()}`,
      downloadUrl: `/api/download/${job.id}/${id}`,
    });
  }
  setStep(job, 'render', 'done', `Rendered ${variants.length} video${variants.length > 1 ? 's' : ''}.`, 1);

  const result = {
    title: planned.title,
    checklist: planned.checklist,
    warnings: [...mergeNotes(notes, clips.map((c) => c.name)), ...planned.warnings],
    variants,
    totalSize: variants.reduce((s, x) => s + x.size, 0),
    settings,
  };
  await fs.writeFile(resultFile(job.id), JSON.stringify(result, null, 2));
  return result;
}

async function startPipeline(job, opts) {
  job.state = 'running';
  job.steps = freshSteps();
  job.error = null;
  job.result = null;
  job.progress = 0;
  job.message = 'Starting…';
  job.lastProgressSent = -1;
  job.abort = new AbortController();
  emit(job);
  try {
    job.result = await runPipeline(job, opts);
    job.state = 'done';
    job.message = 'Done!';
  } catch (err) {
    const cancelled = job.abort.signal.aborted;
    job.state = 'error';
    job.error = {
      message: cancelled ? 'Cancelled.' : err.message || String(err),
      hint: cancelled ? null : err.hint || null,
      detail: cancelled ? null : err.detail || (err instanceof PipelineError ? null : err.stack) || null,
    };
    for (const s of Object.values(job.steps)) if (s.status === 'active') s.status = 'error';
    job.message = job.error.message;
    console.error(`[job ${job.id}]`, err.message, err.detail ? `\n${err.detail}` : '');
  } finally {
    job.abort = null;
    emit(job);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const auth = createAuth({ password: process.env.CLIPFORGE_PASSWORD, secretFile: path.join(DIRS.workspace, '.session-secret') });
if (!LOOPBACK && !auth.enabled && process.env.CLIPFORGE_ALLOW_NO_PASSWORD !== '1') {
  console.error(
    '\n  Refusing to listen on the network without a password — anyone who can reach it could use your Claude plan.\n' +
      '  Set one:  CLIPFORGE_PASSWORD="something-long" npm run start:lan\n',
  );
  process.exit(1);
}

const app = express();
app.set('trust proxy', 'loopback'); // honour X-Forwarded-Proto from a local HTTPS proxy (Tailscale Serve, Caddy)
app.use(express.json({ limit: '1mb' }));
app.use(express.static(DIRS.public));
// Browser build of tus-js-client for resumable uploads.
app.use('/vendor/tus', express.static(path.join(ROOT, 'node_modules', 'tus-js-client', 'dist')));
app.get('/api/auth', auth.status);
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.use('/api', auth.guard);

// Tool availability + option lists, so the UI can warn before a job fails.
let healthCache = null;
app.get('/api/health', async (_req, res) => {
  if (healthCache && Date.now() - healthCache.at < 30_000) return res.json(healthCache.data);

  const data = {
    ffmpeg: onPath('ffmpeg') && onPath('ffprobe'),
    whisper: onPath(process.env.WHISPER_BIN || 'whisper') || (await detectTools()).fasterWhisper,
    claude: onPath(process.env.CLAUDE_BIN || 'claude'),
    hyperframes: fsSync.existsSync(path.join(ROOT, 'node_modules', '.bin', 'hyperframes')) || onPath('hyperframes'),
    tools: Object.fromEntries(
      Object.entries(await detectTools({ fresh: true })).map(([k, v]) => [k, { ...OPTIONAL_TOOLS[k], installed: v }]),
    ),
    options: {
      engines: ENGINES,
      whisperModels: WHISPER_MODELS,
      formats: FORMATS,
      lengths: LENGTHS,
      goals: GOALS,
      captionStyles: CAPTION_STYLES,
      framings: FRAMINGS,
      sizes: Object.fromEntries(Object.entries(SIZE_PRESETS).map(([k, v]) => [k, v.label])),
    },
  };
  healthCache = { at: Date.now(), data };
  res.json(data);
});

// ---------------------------------------------------------------------------
// Uploads: tus resumable protocol (https://tus.io). Files of any size go up in chunks; a
// dropped connection, closed laptop or server restart resumes where it stopped instead of
// starting over. Finished uploads move into the media library.
// ---------------------------------------------------------------------------

const tus = new TusServer({
  path: '/api/uploads',
  datastore: new FileStore({ directory: library.incoming, expirationPeriodInMilliseconds: 7 * 24 * 3600_000 }),
  relativeLocation: true,
  respectForwardedHeaders: true,
  ...(MAX_UPLOAD_BYTES ? { maxSize: MAX_UPLOAD_BYTES } : {}),
  async onUploadCreate(_req, upload) {
    const name = upload.metadata?.filename || '';
    const type = upload.metadata?.filetype || '';
    if (!type.startsWith('video/') && !VIDEO_EXT.test(name)) {
      throw { status_code: 415, body: `${name || 'That file'} is not a video file.\n` };
    }
    const { free } = await diskFree(DIRS.library);
    if (free != null && upload.size && upload.size > free - DISK_HEADROOM) {
      const gb = (n) => (n / 1024 ** 3).toFixed(1);
      throw { status_code: 507, body: `Not enough disk space: ${name} is ${gb(upload.size)} GB, ${gb(Math.max(0, free - DISK_HEADROOM))} GB free.\n` };
    }
    return {};
  },
  async onUploadFinish(_req, upload) {
    const name = String(upload.metadata?.filename || 'video.mp4').slice(0, 200);
    try {
      const asset = await library.ingest(path.join(library.incoming, upload.id), { name, size: upload.size || upload.offset });
      await fs.rm(path.join(library.incoming, `${upload.id}.json`), { force: true });
      return { status_code: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset }) };
    } catch (err) {
      await fs.rm(path.join(library.incoming, upload.id), { force: true });
      await fs.rm(path.join(library.incoming, `${upload.id}.json`), { force: true });
      throw { status_code: 422, body: `${err.message}\n` };
    }
  },
});
app.all(['/api/uploads', '/api/uploads/*'], (req, res) => tus.handle(req, res));
setInterval(() => tus.cleanUpExpiredUploads().catch(() => {}), 3600_000).unref();

// ---- library -------------------------------------------------------------------

async function storageInfo() {
  const [uploads, workspace, output] = await Promise.all([DIRS.uploads, DIRS.workspace, DIRS.output].map(dirSize));
  const disk = await diskFree(DIRS.library);
  return { library: library.totalSize(), projects: uploads + workspace + output, ...disk };
}

app.get('/api/library', async (_req, res) => {
  res.json({ assets: library.list(), storage: await storageInfo() });
});

app.get('/api/library/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  libraryListeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    libraryListeners.delete(res);
  });
});

const withAsset = (handler) => async (req, res, next) => {
  const asset = library.get(req.params.assetId);
  if (!asset) return res.status(404).json({ error: 'That video is no longer in the library.' });
  try {
    await handler(req, res, asset);
  } catch (err) {
    next(err);
  }
};

app.get('/api/library/:assetId/thumb', withAsset((_req, res, a) => res.sendFile(library.thumbPath(a.id), { maxAge: '1y' })));
app.get('/api/library/:assetId/sprite', withAsset((_req, res, a) => res.sendFile(library.spritePath(a.id), { maxAge: '1y' })));
app.get('/api/library/:assetId/stream', withAsset((_req, res, a) => {
  const file = library.streamPath(a.id);
  if (!file) return res.status(409).json({ error: 'Preview is still being prepared.' });
  res.sendFile(file); // supports Range requests, so seeking works on huge files
}));
app.get('/api/library/:assetId/download', withAsset((_req, res, a) => res.download(library.sourcePath(a.id), a.name)));

app.patch('/api/library/:assetId', withAsset(async (req, res, a) => {
  const name = cleanText(req.body?.name, 200);
  if (!name) return res.status(400).json({ error: 'Give the video a name.' });
  res.json({ asset: await library.rename(a.id, name) });
}));

// Deleting a library video also removes it from every project that uses it.
app.delete('/api/library/:assetId', withAsset(async (_req, res, a) => {
  const using = (await allProjects()).filter((j) => j.clips.some((c) => c.assetId === a.id));
  const busy = using.find((j) => j.state === 'running');
  if (busy) return res.status(409).json({ error: `"${projectName(busy)}" is rendering with this video — cancel it first.` });
  for (const job of using) {
    job.clips = job.clips.filter((c) => c.assetId !== a.id);
    await saveManifest(job);
  }
  await library.remove(a.id);
  res.json({ ok: true, removedFrom: using.map((j) => j.id) });
}));

// ---- projects ------------------------------------------------------------------

app.get('/api/projects', async (_req, res) => {
  res.json({ projects: (await allProjects()).map(publicProject) });
});

app.post('/api/projects', async (req, res) => {
  const job = newJob(undefined, cleanText(req.body?.name, 80));
  await saveManifest(job);
  res.status(201).json({ project: publicProject(job) });
});

app.patch('/api/projects/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  job.name = cleanText(req.body?.name, 80);
  await saveManifest(job);
  res.json({ project: publicProject(job) });
});

// POST /api/projects/:jobId/clips — { assetIds: [...] } adds library videos (in that order).
app.post('/api/projects/:jobId/clips', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  if (job.state === 'running') return res.status(409).json({ error: 'A render is running for this project.' });
  const ids = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
  const assets = ids.map((id) => library.get(id));
  if (!ids.length || assets.some((a) => !a)) return res.status(400).json({ error: 'Pick videos from the library.' });
  if (job.clips.length + assets.length > 50) return res.status(400).json({ error: 'A project can hold at most 50 clips.' });
  for (const a of assets) {
    const id = `clip${job.nextClip++}`;
    const { id: _a, name, file, size, createdAt: _c, updatedAt: _u, status: _s, preview: _p, ...meta } = a;
    job.clips.push({ ...meta, id, assetId: a.id, name, size, file: `${id}${path.extname(file)}`, path: library.sourcePath(a.id) });
  }
  await saveManifest(job);
  res.json({ clips: job.clips.map((c) => publicClip(job.id, c)), project: publicProject(job) });
});

// PUT /api/projects/:jobId/order — { clipIds: [...] } sets the clip order Claude sees.
app.put('/api/projects/:jobId/order', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  const order = Array.isArray(req.body?.clipIds) ? req.body.clipIds : [];
  if (order.length !== job.clips.length || !job.clips.every((c) => order.includes(c.id))) {
    return res.status(400).json({ error: 'Clip list is out of date — reload.' });
  }
  job.clips = order.map((id) => job.clips.find((c) => c.id === id));
  await saveManifest(job);
  res.json({ clips: job.clips.map((c) => publicClip(job.id, c)) });
});

app.get('/api/clips/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  res.json({
    jobId: job.id,
    project: publicProject(job),
    clips: job.clips.map((c) => publicClip(job.id, c)),
    logo: publicLogo(job),
    state: snapshot(job),
  });
});

app.delete('/api/clips/:jobId/:clipId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  if (job.state === 'running') return res.status(409).json({ error: 'A render is running for this project.' });
  const clip = job.clips.find((c) => c.id === req.params.clipId);
  if (!clip) return res.status(404).json({ error: 'Unknown clip.' });
  job.clips = job.clips.filter((c) => c !== clip);
  // Library videos stay in the library; only legacy per-project uploads are deleted.
  if (!clip.assetId) {
    const ws = path.join(DIRS.workspace, job.id);
    await fs.rm(clip.path, { force: true });
    await fs.rm(path.join(DIRS.uploads, job.id, 'thumbs', `${clip.id}.jpg`), { force: true });
    await fs.rm(path.join(ws, 'transcripts', clip.id), { recursive: true, force: true });
    for (const f of ['blur/.mp4', 'seekable/.mp4', 'voice/.m4a', 'analysis/.json']) {
      const [sub, ext] = f.split('/.');
      await fs.rm(path.join(ws, sub, `${clip.id}.${ext}`), { force: true });
    }
  }
  await saveManifest(job);
  res.json({ clips: job.clips.map((c) => publicClip(job.id, c)) });
});

app.get('/api/thumb/:jobId/:clipId', async (req, res) => {
  if (!isId(req.params.jobId) || !isId(req.params.clipId)) return res.sendStatus(404);
  const file = path.join(DIRS.uploads, req.params.jobId, 'thumbs', `${req.params.clipId}.jpg`);
  if (!(await exists(file))) return res.sendStatus(404);
  res.sendFile(file);
});

// Preview stream for clips uploaded before the library existed.
app.get('/api/clipfile/:jobId/:clipId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  const clip = job?.clips.find((c) => c.id === req.params.clipId);
  if (!clip || !(await exists(clip.path))) return res.sendStatus(404);
  res.sendFile(clip.path);
});

// Logo / product image for CTA end cards and the watermark. With ?cutout=1 the background
// is removed with rembg when it's installed.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpe?g|webp)$/.test(file.mimetype)),
});
app.post('/api/logo', async (req, res, next) => {
  try {
    const job = req.query.jobId ? await getJob(String(req.query.jobId)) : newJob();
    if (!job) return res.status(404).json({ error: 'Unknown project.' });
    if (job.state === 'running') return res.status(409).json({ error: 'A render is running for this project.' });
    await new Promise((resolve, reject) => logoUpload.single('logo')(req, res, (err) => (err ? reject(err) : resolve())));
    if (!req.file) return res.status(400).json({ error: 'Upload a PNG, JPG or WebP image.' });

    const dir = path.join(DIRS.uploads, job.id);
    await fs.mkdir(dir, { recursive: true });
    for (const f of await fs.readdir(dir)) if (f.startsWith('logo')) await fs.rm(path.join(dir, f), { force: true });
    // Normalize to PNG (keeps transparency) so every renderer path sees one format.
    const src = path.join(dir, `logo-src${path.extname(req.file.originalname).toLowerCase() || '.png'}`);
    await fs.writeFile(src, req.file.buffer);
    const out = path.join(dir, 'logo.png');
    let cutout = false;
    let note = null;
    if (req.query.cutout === '1') {
      if ((await detectTools()).rembg) {
        try {
          await cutoutImage(src, out);
          cutout = true;
        } catch (err) {
          note = `Background removal failed (${String(err.message).split('\n').pop()}) — using the image as-is.`;
        }
      } else {
        note = 'Background removal needs rembg (pip install "rembg[cpu,cli]") — using the image as-is.';
      }
    }
    if (!cutout) {
      const r = await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', out]);
      if (r.code !== 0) return res.status(400).json({ error: 'Could not read that image.' });
    }
    job.logo = { file: 'logo.png', cutout, note, at: Date.now() };
    await saveManifest(job);
    res.json({ jobId: job.id, logo: publicLogo(job) });
  } catch (err) {
    next(err);
  }
});
app.get('/api/logo/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job?.logo) return res.sendStatus(404);
  res.sendFile(path.join(DIRS.uploads, job.id, job.logo.file));
});
app.delete('/api/logo/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  const dir = path.join(DIRS.uploads, job.id);
  for (const f of await fs.readdir(dir).catch(() => [])) if (f.startsWith('logo')) await fs.rm(path.join(dir, f), { force: true });
  job.logo = null;
  await saveManifest(job);
  res.json({ ok: true });
});

const pick = (list, values, fallback) => {
  const v = (Array.isArray(values) ? values : [values]).filter((x) => list.includes(x));
  return v.length ? [...new Set(v)] : fallback;
};
const cleanText = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// POST /api/edit — { jobId, prompt, clips?: [clipId…], settings?: {...} }
app.post('/api/edit', async (req, res) => {
  const { jobId, prompt, clips: clipIds, settings: s = {}, reusePlan = false } = req.body || {};
  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project — upload clips first.' });
  if (job.state === 'running') return res.status(409).json({ error: 'This project is already rendering.' });
  if (!reusePlan && (!prompt || !String(prompt).trim())) return res.status(400).json({ error: 'Describe how you want the video edited.' });

  const ids = Array.isArray(clipIds) && clipIds.length ? clipIds : job.clips.map((c) => c.id);
  const missing = ids.filter((id) => !job.clips.some((c) => c.id === id));
  if (missing.length) return res.status(400).json({ error: `Unknown clip(s): ${missing.join(', ')}` });
  if (!ids.length) return res.status(400).json({ error: 'Upload at least one clip.' });

  const settings = {
    whisperModel: WHISPER_MODELS.includes(s.whisperModel) ? s.whisperModel : 'medium',
    engine: ENGINES.includes(s.engine) ? s.engine : 'auto',
    silence: s.silence !== false,
    shots: s.shots !== false,
    cleanVoice: s.cleanVoice === true,
    useLogo: s.useLogo !== false,
    watermark: s.watermark === true,
    goal: GOALS.includes(s.goal) ? s.goal : 'social',
    formats: pick(Object.keys(FORMATS), s.formats, ['9x16']),
    lengths: pick(LENGTHS, s.lengths, ['30']),
    captions: CAPTION_STYLES.includes(s.captions) ? s.captions : 'bold',
    framing: FRAMINGS.includes(s.framing) ? s.framing : 'blur',
    size: SIZE_PRESETS[s.size] ? s.size : 'balanced',
    accent: /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '#7c5cff',
    brand: cleanText(s.brand, 60),
    cta: cleanText(s.cta, 60),
  };
  const count = settings.formats.length * settings.lengths.length;
  if (count > MAX_VARIANTS) {
    return res.status(400).json({ error: `That's ${count} videos — pick at most ${MAX_VARIANTS} format × length combinations.` });
  }

  startPipeline(job, { prompt: String(prompt || '').slice(0, 8000), clipIds: ids, settings, reusePlan: Boolean(reusePlan) });
  res.status(202).json({ jobId: job.id, statusUrl: `/api/status/${job.id}`, videos: count });
});

app.post('/api/cancel/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  job.abort?.abort();
  res.json({ ok: true });
});

// GET /api/status/:jobId — Server-Sent Events; each message is a full job snapshot.
app.get('/api/status/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\ndata: ${JSON.stringify(snapshot(job))}\n\n`);
  job.listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    job.listeners.delete(res);
  });
});

app.get('/api/plan/:jobId', async (req, res) => {
  if (!isId(req.params.jobId)) return res.sendStatus(404);
  const file = path.join(DIRS.workspace, req.params.jobId, 'edit-plan.json');
  if (!(await exists(file))) return res.status(404).json({ error: 'No plan yet.' });
  res.type('json').send(await fs.readFile(file, 'utf8'));
});

// GET /api/download/:jobId/:variantId[?inline=1] — a rendered MP4 (range requests supported).
// GET /api/download/:jobId — the first video of the latest run.
app.get(['/api/download/:jobId', '/api/download/:jobId/:variantId'], async (req, res) => {
  const job = await getJob(req.params.jobId);
  const variants = job?.result?.variants || [];
  const v = req.params.variantId ? variants.find((x) => x.id === req.params.variantId) : variants[0];
  if (!v) return res.status(404).json({ error: 'No rendered video for that project/version.' });
  const file = path.join(DIRS.output, job.id, v.file);
  if (!(await exists(file))) return res.status(404).json({ error: 'The file was deleted.' });
  if (req.query.inline) return res.sendFile(file);
  res.download(file, v.file);
});

app.get('/api/poster/:jobId/:variantId', async (req, res) => {
  if (!isId(req.params.jobId) || !isId(req.params.variantId)) return res.sendStatus(404);
  const file = path.join(DIRS.output, req.params.jobId, `${req.params.variantId}.jpg`);
  if (!(await exists(file))) return res.sendStatus(404);
  res.sendFile(file);
});

// GET /api/storage[?jobId=…] — disk used by ClipForge (and by one project; library videos not included).
app.get('/api/storage', async (req, res) => {
  const out = await storageInfo();
  out.used = out.library + out.projects;
  if (isId(req.query.jobId)) {
    out.project = (
      await Promise.all([DIRS.uploads, DIRS.workspace, DIRS.output].map((d) => dirSize(path.join(d, req.query.jobId))))
    ).reduce((a, b) => a + b, 0);
  }
  res.json(out);
});

// DELETE /api/jobs/:jobId — remove a project's working files and renders (library videos are kept).
app.delete('/api/jobs/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown project.' });
  if (job.state === 'running') return res.status(409).json({ error: 'Cancel the render first.' });
  for (const d of [DIRS.uploads, DIRS.workspace, DIRS.output]) {
    await fs.rm(path.join(d, job.id), { recursive: true, force: true });
  }
  for (const l of job.listeners) l.end();
  jobs.delete(job.id);
  res.json({ ok: true });
});

// Errors (multer limits, bad JSON, …) → JSON
app.use((err, _req, res, _next) => {
  const status =
    err instanceof multer.MulterError || err instanceof PipelineError || err.type === 'entity.parse.failed' ? 400 : 500;
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'File too large.' : err.message;
  if (status === 500) console.error(err);
  res.status(status).json({ error: message, hint: err.hint });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  ClipForge running at http://${LOOPBACK ? 'localhost' : '127.0.0.1'}:${PORT}`);
  if (!LOOPBACK) {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${PORT}`);
    if (lan.length) console.log(`  On your phone (same Wi-Fi or Tailscale): ${lan.join('  ·  ')}`);
    console.log(`  Password protection: ${auth.enabled ? 'on' : 'OFF'}`);
  }
  console.log('');
});
// A 64 MB upload chunk on a slow phone connection can take longer than Node's 5-minute default.
server.requestTimeout = 0;

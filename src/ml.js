import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { run, tail, PipelineError, isGentle, backgroundThreads, lowerPriority } from './util.js';

/**
 * Local AI models for the library (no API, no GPU): CLIP embeddings of 4 frames per clip power
 * "search by meaning", CLAP tags what can be HEARD in a clip (chainsaw, wind, speech…), which Claude
 * cannot hear from the frames. One shared install in .tools/ml (also used by the Kokoro voiceover),
 * one background worker process that exits when idle.
 */
const PACKAGES = ['@huggingface/transformers@3.8.1', 'kokoro-js@1.2.1'];
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ml-worker.js');
export const EMBED_VERSION = 'clip-b32-v1';
export const SOUND_LABELS = [
  'speech', 'music', 'chainsaw', 'power tool', 'engine', 'wind', 'rain', 'water', 'birds', 'dog',
  'crowd', 'laughter', 'applause', 'traffic', 'hammering', 'wood cracking', 'footsteps', 'silence',
];

/** Zero-shot prompts for music (what CLAP hears) → the short tag shown to Claude. */
export const MUSIC_TAGS_VERSION = 1;
export const MUSIC_GENRES = {
  'hip hop / rap': 'a hip hop rap song', drill: 'a dark drill beat with sliding 808 bass', trap: 'a trap beat with hi-hat rolls',
  phonk: 'a phonk track with cowbell and distorted bass', 'lo-fi': 'a mellow lo-fi hip hop beat', pop: 'a catchy pop song',
  'EDM / house': 'an electronic dance music track', rock: 'a rock song with electric guitars', acoustic: 'an acoustic guitar song',
  cinematic: 'an epic cinematic orchestral score', piano: 'a solo piano piece', 'R&B': 'a smooth R&B song', ambient: 'calm ambient music',
  'funk / disco': 'a funky disco groove', country: 'a country song', latin: 'a latin reggaeton song', jazz: 'a jazz track',
  'meme / quirky': 'a quirky funny cartoon tune',
};
export const MUSIC_MOODS = {
  energetic: 'energetic hype music', aggressive: 'aggressive intense music', happy: 'happy upbeat music', sad: 'sad emotional music',
  calm: 'calm relaxing music', epic: 'epic powerful music', dark: 'dark mysterious music', motivational: 'motivational inspiring music',
  funny: 'funny playful music', romantic: 'romantic music', nostalgic: 'nostalgic dreamy music', tense: 'tense suspenseful music',
  confident: 'confident swagger music', satisfying: 'smooth satisfying chill music',
};

/** Best tags from CLAP scores: the top one, plus the next if close. Exported for tests. */
export function pickTop(scores, table, max = 2) {
  const back = Object.fromEntries(Object.entries(table).map(([k, v]) => [v, k]));
  const sorted = [...scores].sort((a, b) => b.score - a.score).filter((s) => back[s.label]);
  if (!sorted.length) return [];
  return sorted.filter((s, i) => i === 0 || (i < max && s.score >= sorted[0].score * 0.55)).map((s) => back[s.label]);
}

let installing = null;

/** Install (once) the shared model runtime; returns its node_modules folder. */
export function ensureMlPackages(toolsDir) {
  installing ||= (async () => {
    const dir = path.join(toolsDir, 'ml');
    const nm = path.join(dir, 'node_modules');
    const ok = () => PACKAGES.every((p) => fsSync.existsSync(path.join(nm, p.slice(0, p.lastIndexOf('@')), 'package.json')));
    if (ok()) return nm;
    await fs.mkdir(dir, { recursive: true });
    if (!fsSync.existsSync(path.join(dir, 'package.json'))) {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'clipforge-ml', private: true, type: 'module' }));
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = await run(npm, ['install', ...PACKAGES, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, timeoutMs: 25 * 60_000 });
    if (r.code !== 0 || !ok()) {
      installing = null;
      throw new PipelineError('Could not install the local AI models runtime.', { detail: tail(r.stderr) });
    }
    console.log('  Installed the local AI runtime (search by meaning, sound tags, voiceover).');
    return nm;
  })();
  return installing;
}

/** Cosine similarity of unit vectors. */
export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Rank assets for a query embedding: best frame per clip. [{ id, score }] best first. */
export function rankByEmbedding(query, embeddings) {
  return Object.entries(embeddings)
    .map(([id, vecs]) => ({ id, score: Math.max(...vecs.map((v) => cosine(query, v))) }))
    .sort((a, b) => b.score - a.score);
}

/** Turn CLAP scores into the sound tags worth mentioning. */
export function pickSounds(scores) {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  return sorted.filter((s, i) => s.label !== 'silence' && (s.score >= 0.25 || (i === 0 && s.score >= 0.15))).slice(0, 3).map((s) => s.label);
}

export function createMl({ toolsDir, library, isBusy = () => false, onChange = () => {} }) {
  let proc = null;
  let nextId = 1;
  const pending = new Map();
  let idleTimer = null;
  let state = { status: 'idle', error: null }; // idle | installing | ready | error | off
  let started = false;

  async function worker() {
    if (proc) return proc;
    state = { status: 'installing', error: null };
    const nm = await ensureMlPackages(toolsDir);
    const p = spawn(process.execPath, [WORKER], {
      env: {
        ...process.env,
        TRANSFORMERS_ENTRY: path.join(nm, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'),
        MODEL_CACHE: path.join(toolsDir, 'ml', 'models'),
        // Gentle mode: the AI index uses about half the cores, at the lowest priority.
        ...(isGentle() ? { CLIPFORGE_BG_THREADS: String(backgroundThreads()) } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (isGentle() && p.pid) lowerPriority(p.pid);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    // If the worker dies (e.g. the system runs out of memory), writing to it must not crash ClipForge.
    p.stdin.on('error', () => {});
    p.on('error', (err) => console.error('  AI worker could not start:', err.message));
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const cb = pending.get(msg.id);
      if (!cb) return;
      pending.delete(msg.id);
      if (msg.error) cb.reject(new Error(msg.error));
      else cb.resolve(msg.result);
    });
    p.on('close', () => {
      for (const cb of pending.values()) cb.reject(new Error(`AI worker stopped. ${tail(stderr, 3)}`));
      pending.clear();
      proc = null;
    });
    proc = p;
    state = { status: 'ready', error: null };
    return p;
  }

  async function call(method, params) {
    const p = await worker();
    clearTimeout(idleTimer);
    const id = nextId++;
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (!p.stdin.writable) return reject(new Error('AI worker stopped.'));
      p.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    // Free the models' memory after 3 idle minutes.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => proc?.stdin.end(), 3 * 60_000);
    idleTimer.unref?.();
    return result;
  }

  // ---- background indexing --------------------------------------------------
  const embedFile = (id) => path.join(library.assetDir(id), 'embed.json');
  const embeddings = {}; // assetId → [vector ×4] (loaded lazily)
  const queue = [];
  let working = false;

  async function loadEmbeddings() {
    for (const a of library.list()) {
      if (a.kind !== 'video' || a.embedded !== EMBED_VERSION || embeddings[a.id]) continue;
      try {
        embeddings[a.id] = JSON.parse(await fs.readFile(embedFile(a.id), 'utf8')).vectors;
      } catch {
        /* re-index below */
      }
    }
  }

  function enqueue(ids) {
    for (const id of ids) if (!queue.includes(id)) queue.push(id);
    if (!working) drain();
  }

  async function tagMusic(a) {
    const src = library.sourcePath(a.id);
    // Listen where the track is most itself: its drop or first loud part, else the middle.
    const at = a.music?.drop ?? a.music?.loud?.[0]?.[0] ?? Math.max(0, (a.duration || 20) / 2 - 5);
    const start = Math.max(0, Math.min(at, (a.duration || 10) - 10));
    const seconds = Math.min(10, a.duration || 10);
    const genres = pickTop(await call('audioTags', { file: src, start, seconds, labels: Object.values(MUSIC_GENRES) }), MUSIC_GENRES);
    const moods = pickTop(await call('audioTags', { file: src, start, seconds, labels: Object.values(MUSIC_MOODS) }), MUSIC_MOODS, 3);
    await library.setFields(a.id, { musicTags: { v: MUSIC_TAGS_VERSION, genres, moods } });
  }

  async function indexOne(a) {
    if (a.kind === 'audio') return tagMusic(a);
    const work = path.join(library.assetDir(a.id), '.ml');
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    try {
      const src = library.sourcePath(a.id);
      const frames = [];
      for (const f of [0.12, 0.37, 0.62, 0.87]) {
        const out = path.join(work, `f${frames.length}.jpg`);
        const r = await run('ffmpeg', ['-v', 'error', '-y', '-ss', String((a.duration || 1) * f), '-i', src, '-frames:v', '1', '-vf', 'scale=336:-2', out], { timeoutMs: 120_000, background: true });
        if (r.code === 0) frames.push(out);
      }
      const patch = {};
      if (frames.length) {
        const vectors = await call('embedImages', { paths: frames });
        await fs.writeFile(embedFile(a.id), JSON.stringify({ model: EMBED_VERSION, vectors }));
        embeddings[a.id] = vectors;
        patch.embedded = EMBED_VERSION;
      }
      if (a.hasAudio && a.duration >= 1.5) {
        const seconds = Math.min(10, a.duration);
        const start = Math.max(0, a.duration / 2 - seconds / 2);
        patch.sounds = pickSounds(await call('audioTags', { file: src, start, seconds, labels: SOUND_LABELS }));
      } else {
        patch.sounds = [];
      }
      await library.setFields(a.id, patch);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  async function drain() {
    working = true;
    try {
      while (queue.length) {
        // Background work only: wait while anything else runs, and when memory is tight (the models
        // need ~1.5 GB) — never compete with a render or starve the codespace.
        while (isBusy() || os.freemem() < 1.8 * 1024 ** 3) await new Promise((r) => setTimeout(r, 20_000));
        const a = library.get(queue.shift());
        if (!a || a.status !== 'ready') continue;
        try {
          await indexOne(a);
        } catch (err) {
          state = { status: 'error', error: err.message };
          console.error(`[ai-index ${a.id}]`, err.message);
          if (/install|Could not|fetch|network|ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
            queue.length = 0; // runtime unavailable — try again on the next restart / new upload
            break;
          }
        }
        onChange({ type: 'ml', ml: status() });
      }
    } finally {
      working = false;
      onChange({ type: 'ml', ml: status() });
    }
  }

  // Music is tagged once its scan (tempo, drop) is done, so CLAP listens to the right part.
  const needsIndex = (a) =>
    a.kind === 'audio' ? Boolean(a.music) && a.musicTags?.v !== MUSIC_TAGS_VERSION : a.embedded !== EMBED_VERSION || !Array.isArray(a.sounds);

  const status = () => ({ ...state, queued: queue.length + (working ? 1 : 0), indexed: Object.keys(embeddings).length });

  return {
    status,
    /** Index everything that isn't yet (after startup and whenever a clip becomes ready). */
    async start() {
      // Machines with little memory (under 6 GB) skip local models entirely; search falls back to keywords.
      if (os.totalmem() < 6 * 1024 ** 3) {
        state = { status: 'off', error: 'Not enough memory for the local AI models on this machine.' };
        return;
      }
      started = true;
      await loadEmbeddings();
      enqueue(library.list().filter((a) => a.status === 'ready' && needsIndex(a)).map((a) => a.id));
    },
    onReady(a) {
      if (started && state.status !== 'off' && needsIndex(a)) enqueue([a.id]);
    },
    forget(id) {
      delete embeddings[id];
    },
    hasIndex: () => Object.keys(embeddings).length > 0,
    /** Clips ranked by how well their frames match a text query. */
    async search(text, { limit = 60 } = {}) {
      if (!Object.keys(embeddings).length) return [];
      const [q] = await call('embedText', { texts: [text] });
      return rankByEmbedding(q, embeddings).slice(0, limit);
    },
    stop() {
      proc?.kill();
    },
  };
}

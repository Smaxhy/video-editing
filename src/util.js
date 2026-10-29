import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Error with a short user-facing message plus optional technical detail. */
export class PipelineError extends Error {
  constructor(message, { detail, hint, cause } = {}) {
    super(message, { cause });
    this.name = 'PipelineError';
    this.detail = detail;
    this.hint = hint;
  }
}

/**
 * Spawn a process and collect its output.
 * onLine is called with every stdout/stderr line as it arrives (for progress parsing).
 * Rejects with { code: 'ENOENT' } when the binary is missing.
 */
/**
 * Every running child, so cancel / force stop / shutdown can take down the WHOLE process tree
 * (HyperFrames' Chrome workers, ffmpeg encoders, Python helpers) — not just the direct child.
 */
const live = new Set();
const isWin = process.platform === 'win32';
function killTree(child, sig) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (isWin) child.kill(sig);
    else process.kill(-child.pid, sig); // the child leads its own process group
  } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}
function stopTree(child) {
  killTree(child, 'SIGTERM');
  setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref();
}
/** Stop every running child process tree (force stop / update / shutdown). Returns how many. */
export function killAllChildren() {
  const n = live.size;
  for (const c of live) stopTree(c);
  return n;
}
process.on('exit', () => { for (const c of live) killTree(c, 'SIGKILL'); });

/**
 * Gentle background work: previews, compressing imports and AI indexing run at the lowest CPU
 * priority on about half the processor, and only one big background encode runs at a time — so uploads
 * and imports never make the computer crawl. Renders keep full speed. "Full speed" in the library
 * settings turns it off.
 */
let gentle = true;
export const setGentle = (on) => { gentle = on !== false; };
export const isGentle = () => gentle;
// ffmpeg's decoder, filters and encoder each get this many threads and run side by side, so a
// quarter of the cores per stage comes out at roughly half the computer in total.
export const backgroundThreads = () => Math.max(1, Math.floor((os.availableParallelism?.() || os.cpus().length) / 4));
export function lowerPriority(pid) {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_LOW);
  } catch { /* not allowed here — fine */ }
}
/** ffmpeg arguments capped to the background thread budget: filters, every decoder (before each -i) and the encoder (before the output). */
export function gentleArgs(args, threads = backgroundThreads()) {
  if (args.includes('-threads') || args.length < 2) return args;
  const n = String(threads);
  const body = args.slice(0, -1).flatMap((a) => (a === '-i' ? ['-threads', n, a] : [a]));
  return ['-filter_threads', n, ...body, '-threads', n, args[args.length - 1]];
}
let heavySlots = 1;
const heavyWaiting = [];
async function heavySlot() {
  if (heavySlots > 0) {
    heavySlots--;
    return;
  }
  await new Promise((r) => heavyWaiting.push(r));
}
function releaseHeavy() {
  const next = heavyWaiting.shift();
  if (next) next();
  else heavySlots++;
}

/**
 * `background: true` runs the command gently (see above); `background: 'heavy'` also waits for the
 * single big-encode slot.
 */
export async function run(cmd, args, opts = {}) {
  const bg = opts.background && gentle;
  if (!bg) return spawnRun(cmd, args, opts);
  const heavy = opts.background === 'heavy';
  if (heavy) await heavySlot();
  try {
    if (opts.signal?.aborted) return { code: null, signal: 'SIGTERM', stdout: '', stderr: 'cancelled', timedOut: false };
    return await spawnRun(cmd, cmd === 'ffmpeg' ? gentleArgs(args) : args, { ...opts, lowPriority: true });
  } finally {
    if (heavy) releaseHeavy();
  }
}

function spawnRun(cmd, args, { cwd, input, env, unsetEnv = [], onLine, timeoutMs, signal, lowPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    for (const key of unsetEnv) delete childEnv[key];
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin, // own process group → the whole tree can be stopped
    });
    live.add(child);
    if (lowPriority && child.pid) lowerPriority(child.pid);

    let stdout = '';
    let stderr = '';
    let timer;
    let killedForTimeout = false;

    const lineBuffers = { stdout: '', stderr: '' };
    const feed = (stream, chunk) => {
      if (!onLine) return;
      // tqdm and similar progress bars redraw with \r, so treat it as a line break too.
      lineBuffers[stream] += chunk;
      const parts = lineBuffers[stream].split(/\r\n|\r|\n/);
      lineBuffers[stream] = parts.pop();
      for (const line of parts) if (line.trim()) onLine(line, stream);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; feed('stdout', d); });
    child.stderr.on('data', (d) => { stderr += d; feed('stderr', d); });

    if (timeoutMs) {
      timer = setTimeout(() => {
        killedForTimeout = true;
        stopTree(child);
      }, timeoutMs);
    }
    const onAbort = () => stopTree(child);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      live.delete(child);
      reject(err);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      live.delete(child);
      signal?.removeEventListener('abort', onAbort);
      for (const stream of ['stdout', 'stderr']) {
        if (onLine && lineBuffers[stream].trim()) onLine(lineBuffers[stream], stream);
      }
      resolve({ code, signal: sig, stdout, stderr, timedOut: killedForTimeout });
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Last N non-empty lines of some process output, for error messages. */
export function tail(text, n = 25) {
  return String(text || '')
    .split(/\r?\n|\r/)
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n');
}

/** Probe a media file with ffprobe: duration, dimensions, audio presence. */
export async function probe(file) {
  let res;
  try {
    res = await run('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ], { timeoutMs: 2 * 60_000 });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PipelineError('ffprobe not found — FFmpeg is required.', {
        hint: 'Install FFmpeg (e.g. `brew install ffmpeg` or `sudo apt install ffmpeg`).',
      });
    }
    throw err;
  }
  if (res.code !== 0) {
    throw new PipelineError(`Could not read media file ${path.basename(file)}.`, {
      detail: tail(res.stderr),
    });
  }
  const info = JSON.parse(res.stdout);
  const video = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  let width = video?.width || 0;
  let height = video?.height || 0;
  const rotation = Math.abs(
    Number(video?.side_data_list?.find((d) => d.rotation != null)?.rotation ?? video?.tags?.rotate ?? 0),
  );
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return {
    duration: Number(info.format?.duration || video?.duration || audio?.duration || 0),
    width,
    height,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    // Codec details decide whether a browser can preview the file as-is (see library.js).
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    pixFmt: video?.pix_fmt || null,
    container: info.format?.format_name || null,
    bitRate: Number(info.format?.bit_rate || 0),
    // Title/artist/genre help Claude pick music; keys vary in case between containers.
    tags: Object.fromEntries(
      Object.entries(info.format?.tags || {})
        .map(([k, v]) => [k.toLowerCase(), String(v).slice(0, 120)])
        .filter(([k]) => ['title', 'artist', 'album', 'genre', 'comment'].includes(k)),
    ),
  };
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Hard-link a file into place (fast, no extra disk), falling back to a copy across devices. */
export async function linkOrCopy(src, dest) {
  await fs.rm(dest, { force: true });
  try {
    await fs.link(src, dest);
  } catch {
    await fs.copyFile(src, dest);
  }
}

export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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
export function run(cmd, args, { cwd, input, env, unsetEnv = [], onLine, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    for (const key of unsetEnv) delete childEnv[key];
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);
    }
    if (signal) {
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
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
    ]);
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

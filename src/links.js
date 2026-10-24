import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadLink } from './style.js';
import { run, tail, PipelineError } from './util.js';

/**
 * "Add from links": paste TikTok / Instagram / YouTube / … links and ClipForge saves them into the
 * library (yt-dlp) — as a video, as a sound (music track, audio only) or both — optionally into a
 * folder. One link at a time; a link that fails doesn't stop the rest.
 */
export const LINK_MODES = ['video', 'sound', 'both'];

/** Clean list of http(s) links from free text (one per line, spaces or commas). Exported for tests. */
export function parseLinks(text) {
  const raw = Array.isArray(text) ? text.join('\n') : String(text || '');
  const seen = new Set();
  return (raw.match(/https?:\/\/[^\s,<>"']+/gi) || [])
    .map((u) => u.replace(/[).,;]+$/, ''))
    .filter((u) => !seen.has(u) && seen.add(u))
    .slice(0, 50);
}

export function createLinkImports({ library, toolsDir, work, onChange = () => {} }) {
  const jobs = [];
  let busy = false;
  const pub = (j) => ({ id: j.id, mode: j.mode, total: j.urls.length, done: j.done, failed: j.failed, state: j.state, message: j.message, createdAt: j.createdAt });
  const changed = () => onChange({ type: 'links', jobs: jobs.slice(0, 10).map(pub) });

  /** Audio only, as a music track. */
  async function soundOf(file, url, title, signal) {
    const out = path.join(library.incoming, `link-sound-${crypto.randomBytes(4).toString('hex')}.m4a`);
    const r = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '256k', out], { signal, timeoutMs: 20 * 60_000 });
    if (r.code !== 0) {
      await fs.rm(out, { force: true });
      throw new PipelineError('That link has no sound to save.', { detail: tail(r.stderr, 3) });
    }
    return library.ingest(out, { name: `${title} (sound).m4a`, size: (await fs.stat(out)).size, source: { type: 'link', url } });
  }

  async function runJob(j) {
    j.state = 'running';
    for (const [i, url] of j.urls.entries()) {
      if (j.abort.signal.aborted) break;
      j.message = `Downloading ${i + 1}/${j.urls.length}…`;
      changed();
      const dir = path.join(work, `${j.id}-${i}`);
      try {
        const file = await downloadLink(url, dir, { toolsDir, signal: j.abort.signal });
        const title = path.basename(file).replace(/\.[^.]+$/, '');
        const made = [];
        if (j.mode !== 'sound') {
          const v = await library.ingest(file, { name: path.basename(file), size: (await fs.stat(file)).size, source: { type: 'link', url } });
          made.push(v);
          // The ingested copy moved the file; take the sound from the library copy.
          if (j.mode === 'both') made.push(await soundOf(library.sourcePath(v.id), url, title, j.abort.signal));
        } else {
          made.push(await soundOf(file, url, title, j.abort.signal));
        }
        if (j.folder) for (const a of made) await library.setFields(a.id, { folder: j.folder });
        j.done++;
      } catch (err) {
        j.failed.push({ url, error: err.hint || err.message });
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      changed();
    }
    j.state = j.abort.signal.aborted ? 'cancelled' : 'done';
    j.message = '';
    changed();
  }

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      for (let j; (j = jobs.find((x) => x.state === 'queued')); ) await runJob(j);
    } finally {
      busy = false;
    }
  }

  return {
    jobs: () => jobs.slice(0, 10).map(pub),
    busy: () => busy,
    add({ urls, mode = 'video', folder = null }) {
      const list = parseLinks(urls);
      if (!list.length) throw Object.assign(new Error('Paste at least one link (https://…).'), { status: 400 });
      const j = { id: crypto.randomUUID().slice(0, 8), urls: list, mode: LINK_MODES.includes(mode) ? mode : 'video', folder, done: 0, failed: [], state: 'queued', message: 'Waiting…', createdAt: Date.now(), abort: new AbortController() };
      jobs.unshift(j);
      jobs.splice(20);
      changed();
      drain();
      return pub(j);
    },
    cancelAll() {
      for (const j of jobs) if (j.state === 'running' || j.state === 'queued') j.abort.abort();
      for (const j of jobs) if (j.state === 'queued') j.state = 'cancelled';
      changed();
    },
  };
}

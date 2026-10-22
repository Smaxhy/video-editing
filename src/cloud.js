import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { run, tail, PipelineError } from './util.js';
import { onPath } from './tools.js';
import { VIDEO_EXT, AUDIO_EXT } from './library.js';

/**
 * Cloud import through rclone (https://github.com/rclone/rclone) — Google Drive first, but any
 * of rclone's 70+ backends (Dropbox, OneDrive, S3, a NAS…) you've set up with `rclone config`
 * shows up too. Whole folders (or a whole drive) are copied into the library one file at a time,
 * skipping files that were imported before.
 */

let RCLONE = process.env.RCLONE_BIN || 'rclone';
const MIN_RCLONE = [1, 66];

/** "rclone v1.60.1-DEV" → [1, 60]; null when it isn't installed. */
async function rcloneVersion(bin) {
  if (!onPath(bin)) return null;
  const r = await run(bin, ['version']).catch(() => null);
  const m = r?.stdout.match(/rclone v(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Use a recent rclone: Linux distros ship old ones (Debian bookworm has 1.60). If the installed one is
 * missing or older than MIN_RCLONE, download the current official build into toolsDir once.
 */
let ensuring = null;
export function ensureRclone(toolsDir) {
  ensuring ||= (async () => {
    if (process.env.RCLONE_BIN) return RCLONE;
    const local = path.join(toolsDir, 'rclone');
    if (fsSync.existsSync(local)) return (RCLONE = local);
    const v = await rcloneVersion('rclone');
    if (v && (v[0] > MIN_RCLONE[0] || (v[0] === MIN_RCLONE[0] && v[1] >= MIN_RCLONE[1]))) return (RCLONE = 'rclone');
    const os = { linux: 'linux', darwin: 'osx' }[process.platform];
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    if (!os || !arch) return RCLONE;
    await fs.mkdir(toolsDir, { recursive: true });
    const zip = path.join(toolsDir, 'rclone.zip');
    for (const url of [
      `https://downloads.rclone.org/rclone-current-${os}-${arch}.zip`,
      `https://github.com/rclone/rclone/releases/download/v1.71.2/rclone-v1.71.2-${os}-${arch}.zip`,
    ]) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        await fs.writeFile(zip, Buffer.from(await r.arrayBuffer()));
        // Pull the single `rclone` binary out of the zip (python3 is always there; unzip as a fallback).
        const py = "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nm=[n for n in z.namelist() if n.endswith('/rclone')][0]\nopen(sys.argv[2],'wb').write(z.read(m))";
        let x = await run('python3', ['-I', '-c', py, zip, `${local}.part`]).catch(() => ({ code: 1 }));
        if (x.code !== 0) x = await run('sh', ['-c', `unzip -p "${zip}" '*/rclone' > "${local}.part"`]).catch(() => ({ code: 1 }));
        if (x.code !== 0) continue;
        await fs.chmod(`${local}.part`, 0o755);
        await fs.rename(`${local}.part`, local);
        console.log(`  Installed rclone for Google Drive import: ${(await run(local, ['version'])).stdout.split('\n')[0]}`);
        return (RCLONE = local);
      } catch {
        /* try the next source */
      } finally {
        await fs.rm(zip, { force: true }).catch(() => {});
      }
    }
    return RCLONE; // keep whatever is installed
  })();
  return ensuring;
}
const PARALLEL = 2;

/** Folder/file id from any Google Drive link (or a bare id). */
export function parseDriveLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m =
    s.match(/\/folders\/([\w-]{10,})/) ||
    s.match(/\/file\/d\/([\w-]{10,})/) ||
    s.match(/[?&]id=([\w-]{10,})/) ||
    s.match(/^([\w-]{20,})$/);
  if (!m) return null;
  return { id: m[1], isFile: /\/file\/d\//.test(s) };
}

const isMedia = (name) => VIDEO_EXT.test(name) || AUDIO_EXT.test(name);

/** rclone answers config questions as JSON; parse the last JSON object in its output. */
function parseState(stdout) {
  const i = stdout.indexOf('{');
  if (i < 0) return { State: '' };
  try {
    return JSON.parse(stdout.slice(i));
  } catch {
    return { State: '' };
  }
}

export function createCloud({ library, toolsDir, onChange = () => {} }) {
  const ready = () => (toolsDir ? ensureRclone(toolsDir) : Promise.resolve(RCLONE));
  ready().catch(() => {});
  const jobs = new Map();
  let connect = { status: 'idle' };
  let connectProc = null;

  const emitJob = (job) => onChange({ type: 'import', job: publicJob(job) });
  const emitConnect = () => onChange({ type: 'connect', connect });
  const publicJob = (j) => {
    const { procs: _p, files: _f, ...rest } = j;
    return rest;
  };

  async function remotes() {
    await ready();
    if (!onPath(RCLONE)) return [];
    const r = await run(RCLONE, ['listremotes', '--long']);
    return r.stdout
      .split('\n')
      .map((l) => l.match(/^(.+?):\s+(\S+)/))
      .filter(Boolean)
      .map(([, name, type]) => ({ name, type }));
  }

  async function checkRemote(name) {
    const r = (await remotes()).find((x) => x.name === name);
    if (!r) throw new PipelineError(`No connected storage called "${name}".`);
    return r;
  }

  /** rclone flags that point it at a shared folder / "Shared with me" on Google Drive. */
  function scopeFlags(remote, { link, sharedWithMe }) {
    const flags = [];
    if (remote.type === 'drive') {
      const parsed = parseDriveLink(link);
      if (link && !parsed) throw new PipelineError("That doesn't look like a Google Drive folder link.", { hint: 'Open the folder in Drive, click Share → Copy link, and paste it here.' });
      if (parsed?.isFile) throw new PipelineError('That is a link to a single file — paste a folder link (or leave it empty for your whole Drive).');
      if (parsed) flags.push('--drive-root-folder-id', parsed.id);
      if (sharedWithMe && !parsed) flags.push('--drive-shared-with-me');
    }
    return flags;
  }

  // ---- connecting Google Drive (rclone's non-interactive config: https://rclone.org/commands/rclone_config_create/)
  async function configStep(args) {
    const r = await run(RCLONE, [...args, '--non-interactive']);
    if (r.code !== 0) throw new PipelineError('rclone could not save the connection.', { detail: tail(r.stderr) });
    return parseState(r.stdout);
  }

  /** Answer any remaining setup questions with rclone's defaults (e.g. "is this a shared drive? no"). */
  async function finishConfig(name, state) {
    for (let i = 0; state.State && i < 10; i++) {
      if (state.Option?.Name === 'config_token') throw new PipelineError('Google sign-in did not complete.');
      state = await configStep(['config', 'update', name, '--continue', '--state', state.State, '--result', state.Option?.DefaultStr ?? '']);
    }
    connect = { status: 'done', remote: name };
    emitConnect();
  }

  async function startConnect({ name = 'gdrive', local }) {
    await ready();
    if (!onPath(RCLONE)) throw new PipelineError('rclone is not installed.', { hint: 'Install it from https://rclone.org/install/ (or run scripts/setup.sh), then reload.' });
    if (!/^[\w-]{1,32}$/.test(name)) throw new PipelineError('Use letters, numbers and dashes for the name.');
    await cancelConnect();
    // Read-only access: ClipForge can copy from your Drive but never change or delete anything there.
    const first = await configStep(['config', 'create', name, 'drive', 'scope=drive.readonly']);
    if (first.Option?.Name !== 'config_is_local') return finishConfig(name, first).then(() => connect);

    if (!local) {
      const next = await configStep(['config', 'update', name, '--continue', '--state', first.State, '--result', 'false']);
      const cmd = next.Option?.Help?.match(/rclone authorize "drive"[^\n]*/)?.[0] || 'rclone authorize "drive"';
      connect = { status: 'need-token', remote: name, command: cmd, state: next.State };
      emitConnect();
      return connect;
    }

    // rclone listens on 127.0.0.1:53682 (on the ClipForge machine) for Google's redirect. On that
    // machine the redirect completes by itself; from a phone or another computer the redirect lands
    // on a page that can't load — the person pastes its address back and finishFromRedirect relays it.
    connect = { status: 'starting', remote: name };
    const proc = spawn(RCLONE, ['config', 'update', name, '--continue', '--state', first.State, '--result', 'true', '--non-interactive'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    connectProc = proc;
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => {
      err += d;
      const local = err.match(/https?:\/\/127\.0\.0\.1:\d+\/auth\?state=[\w-]+/)?.[0];
      if (local && connect.status === 'starting') {
        connect = { status: 'resolving', remote: name };
        googleUrl(local).then((url) => {
          if (connect.status !== 'resolving') return;
          connect = { status: 'waiting-browser', remote: name, url, state: new URL(local).searchParams.get('state') };
          emitConnect();
        });
      }
    });
    proc.on('close', async (code) => {
      if (connectProc !== proc) return; // cancelled
      connectProc = null;
      try {
        if (code !== 0) {
          console.error(`[google sign-in] rclone exited with ${code}:\n${tail(err, 15)}`);
          const expired = /invalid_grant/.test(err);
          throw new PipelineError(
            expired ? 'Google didn’t accept that sign-in — it expired or was already used. Tap “Connect Google Drive” and try again.' : 'Google sign-in failed.',
            { detail: tail(err) },
          );
        }
        await finishConfig(name, parseState(out));
      } catch (e) {
        // Don't leave a half-made remote behind — it would look connected but fail.
        await run(RCLONE, ['config', 'delete', name]).catch(() => {});
        connect = { status: 'error', remote: name, error: e.message, detail: e.detail || null };
        emitConnect();
      }
    });
    // Give rclone a moment to print the sign-in link so the first response already has it.
    for (let i = 0; i < 50 && ['starting', 'resolving'].includes(connect.status); i++) await new Promise((r) => setTimeout(r, 100));
    return connect;
  }

  /** rclone's local /auth page just redirects to Google — hand out Google's address so any device can open it. */
  async function googleUrl(local) {
    try {
      const r = await fetch(local, { redirect: 'manual' });
      const loc = r.headers.get('location');
      if (loc && /^https:\/\/accounts\.google\.com\//.test(loc)) return loc;
    } catch {
      /* fall back to the local address (works on the ClipForge machine itself) */
    }
    return local;
  }

  /**
   * After "Allow", Google redirects the browser to http://127.0.0.1:53682/?state=…&code=… — which only
   * exists on the ClipForge machine. The person pastes that address; we pass its query to rclone here.
   */
  async function finishFromRedirect(pasted) {
    if (connect.status !== 'waiting-browser') throw new PipelineError('Start connecting Google Drive first.');
    let u;
    try {
      u = new URL(String(pasted || '').trim());
    } catch {
      throw new PipelineError('Paste the whole address of the page Google opened — it starts with http://127.0.0.1:53682/');
    }
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== '53682') {
      throw new PipelineError('That isn\'t the right address — it should start with http://127.0.0.1:53682/');
    }
    if (u.searchParams.get('error')) throw new PipelineError('Google said access was not allowed — try again and tap Allow.');
    if (u.searchParams.get('state') !== connect.state || !u.searchParams.get('code')) {
      throw new PipelineError('That address is from an older sign-in — tap “Sign in with Google” again and use the new one.');
    }
    const q = new URLSearchParams({ state: u.searchParams.get('state'), code: u.searchParams.get('code'), scope: u.searchParams.get('scope') || '' });
    const r = await fetch(`http://127.0.0.1:53682/?${q}`).catch(() => null);
    if (!r || !r.ok) throw new PipelineError('The sign-in expired — tap “Sign in with Google” again.');
    // rclone now trades the code for a token and finishes; wait for it.
    for (let i = 0; i < 150 && connect.status === 'waiting-browser'; i++) await new Promise((res) => setTimeout(res, 100));
    if (connect.status === 'error') throw new PipelineError(connect.error, { detail: connect.detail });
    return connect;
  }

  async function submitToken(token) {
    if (connect.status !== 'need-token') throw new PipelineError('Start connecting Google Drive first.');
    const t = String(token || '').trim();
    if (!t.startsWith('{')) throw new PipelineError('Paste the whole result rclone printed — it starts with { and ends with }.');
    const { remote, state } = connect;
    try {
      await finishConfig(remote, await configStep(['config', 'update', remote, '--continue', '--state', state, '--result', t]));
    } catch (e) {
      connect = { ...connect, error: e.message };
      throw e;
    }
    return connect;
  }

  /** Stop a sign-in in progress and remove the half-made remote so it doesn't show as connected. */
  async function cancelConnect() {
    connectProc?.kill();
    connectProc = null;
    if (connect.remote && connect.status !== 'done') await run(RCLONE, ['config', 'delete', connect.remote]).catch(() => {});
    connect = { status: 'idle' };
  }

  // ---- browsing + importing -------------------------------------------------------
  async function listFiles({ remote: name, link, sharedWithMe, signal }) {
    const remote = await checkRemote(name);
    const flags = scopeFlags(remote, { link, sharedWithMe });
    // Google Drive folders are addressed by link (folder id); other storage by a plain folder path.
    const folder = remote.type === 'drive' ? '' : String(link || '').trim().replace(/(.)\/+$/, '$1');
    if (folder.split('/').includes('..')) throw new PipelineError('Folder paths cannot contain "..".');
    const base = `${name}:${folder}`;
    const r = await run(RCLONE, ['lsjson', base, '-R', '--files-only', '--fast-list', ...flags], { signal, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) {
      const detail = tail(r.stderr);
      const hint = /notFound|404/.test(detail)
        ? 'Check the link, and that the folder is shared with the Google account you connected.'
        : /token|oauth|401|invalid_grant/i.test(detail) ? 'The Google connection expired — connect Google Drive again.' : undefined;
      throw new PipelineError('Could not list that folder.', { detail, hint });
    }
    const files = JSON.parse(r.stdout || '[]')
      .filter((f) => !f.IsDir && isMedia(f.Name))
      .map((f) => {
        const file = { path: folder ? `${folder}/${f.Path}` : f.Path, name: f.Name, size: f.Size, id: f.ID || null, kind: VIDEO_EXT.test(f.Name) ? 'video' : 'audio' };
        return { ...file, imported: Boolean(library.findBySource({ remote: name, ...file })) };
      });
    return { remote, flags, files };
  }

  async function preview(opts) {
    const { files } = await listFiles(opts);
    const fresh = files.filter((f) => !f.imported);
    return {
      videos: files.filter((f) => f.kind === 'video').length,
      music: files.filter((f) => f.kind === 'audio').length,
      alreadyImported: files.length - fresh.length,
      newFiles: fresh.length,
      newBytes: fresh.reduce((s, f) => s + f.size, 0),
      sample: fresh.slice(0, 8).map((f) => f.path),
    };
  }

  /** `check(bytes)` runs before any download starts (e.g. a disk-space check) and may throw. */
  async function startImport({ remote: name, link, sharedWithMe, check }) {
    const { remote, flags, files } = await listFiles({ remote: name, link, sharedWithMe });
    const todo = files.filter((f) => !f.imported);
    await check?.(todo.reduce((s, f) => s + f.size, 0));
    const job = {
      id: crypto.randomBytes(5).toString('hex'),
      remote: name,
      label: link ? `Folder from ${remote.type === 'drive' ? 'Google Drive' : name}` : sharedWithMe ? 'Shared with me' : `All of ${remote.type === 'drive' ? 'Google Drive' : name}`,
      state: 'running',
      total: todo.length,
      skipped: files.length - todo.length,
      done: 0,
      failed: [],
      totalBytes: todo.reduce((s, f) => s + f.size, 0),
      doneBytes: 0,
      current: [],
      startedAt: Date.now(),
      files: todo,
      procs: new Set(),
    };
    jobs.set(job.id, job);
    runImport(job, remote, flags);
    return publicJob(job);
  }

  async function runImport(job, remote, flags) {
    let next = 0;
    const worker = async () => {
      while (job.state === 'running' && next < job.files.length) {
        const f = job.files[next++];
        await importOne(job, f, flags).catch((err) => {
          if (job.state === 'running') job.failed.push({ name: f.path, error: err.message });
        });
        job.done++;
        emitJob(job);
      }
    };
    emitJob(job);
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (job.state === 'running') job.state = 'done';
    job.current = [];
    job.files = [];
    emitJob(job);
  }

  async function importOne(job, f, flags) {
    const tmp = path.join(library.incoming, `import-${job.id}-${crypto.randomBytes(3).toString('hex')}`);
    await fs.mkdir(tmp, { recursive: true });
    const cur = { name: f.path, size: f.size, bytes: 0 };
    job.current.push(cur);
    // rclone writes a .partial file next to the destination — its size is our progress.
    const poll = setInterval(async () => {
      const entries = await fs.readdir(tmp).catch(() => []);
      let b = 0;
      for (const e of entries) b += (await fs.stat(path.join(tmp, e)).catch(() => ({ size: 0 }))).size;
      cur.bytes = Math.min(b, f.size);
      emitJob(job);
    }, 1000);
    try {
      const dest = path.join(tmp, f.name.replace(/[\\/]/g, '_'));
      const r = await new Promise((resolve, reject) => {
        const p = spawn(RCLONE, ['copyto', `${job.remote}:${f.path}`, dest, '--retries', '5', '--low-level-retries', '20', ...flags], { stdio: ['ignore', 'ignore', 'pipe'] });
        job.procs.add(p);
        let err = '';
        p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
        p.on('error', reject);
        p.on('close', (code) => {
          job.procs.delete(p);
          resolve({ code, err });
        });
      });
      if (job.state !== 'running') return;
      if (r.code !== 0) throw new PipelineError(tail(r.err, 2) || 'download failed');
      const size = (await fs.stat(dest)).size;
      await library.ingest(dest, { name: f.name, size, source: { remote: job.remote, id: f.id, path: f.path, size: f.size } });
      job.doneBytes += f.size;
    } finally {
      clearInterval(poll);
      job.current = job.current.filter((c) => c !== cur);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  function cancelImport(id) {
    const job = jobs.get(id);
    if (!job || job.state !== 'running') return false;
    job.state = 'cancelled';
    for (const p of job.procs) p.kill();
    emitJob(job);
    return true;
  }

  return {
    available: () => onPath(RCLONE),
    remotes,
    connectState: () => connect,
    startConnect,
    submitToken,
    finishFromRedirect,
    cancelConnect,
    preview,
    startImport,
    cancelImport,
    jobs: () => [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt - a.startedAt),
  };
}

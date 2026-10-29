import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run } from './util.js';
import { diskFree } from './storage.js';

/**
 * "Move to a new computer": the old ClipForge (say, a codespace) shows a one-time transfer code, and
 * the new one (a PC, a server) downloads everything with it — library videos and music with their AI
 * scans, folders, learned styles, projects with their plans and renders, Autopilot. Re-creatable
 * caches and leftovers stay behind (they're re-made on demand). Files already copied are skipped, so
 * an interrupted transfer just continues when started again.
 */
const ROOTS = ['library', 'uploads', 'workspace', 'output'];
const SKIP = [
  /^library\/[^/]+\/cache\//, // polished copies, studio sound, slow motion… (re-made when needed)
  /^library\/\.incoming\//,
  /^workspace\/(activity\.json|\.session-secret|\.update-now|server\.(log|pid))$/,
  /^workspace\/_links\//,
  /^workspace\/[^/]+\/project\//, // a render's composition (re-made)
  /^output\/[^/]+-prev\//,
  /\/\.hf-history\//,
  /\.raw\.mp4$/,
  /\.(part|tmp)(\.[a-z0-9]+)?$/i,
];
/** Single files both sides may have: merged instead of replaced. */
const MERGE = new Set(['library/.folders.json', 'library/.styles/styles.json', 'library/.library.json', 'output/_autopilot/autopilot.json']);
const CODE_TTL = 6 * 3600_000;

export const skipPath = (rel) => SKIP.some((re) => re.test(rel));

/** Every file worth copying under the data folders: [{ p: 'library/abc/meta.json', size }]. */
export async function buildManifest(dirs) {
  const files = [];
  async function walk(abs, rel) {
    for (const e of await fs.readdir(abs, { withFileTypes: true }).catch(() => [])) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!skipPath(`${r}/`)) await walk(path.join(abs, e.name), r);
      } else if (e.isFile() && !skipPath(r)) {
        const st = await fs.stat(path.join(abs, e.name)).catch(() => null);
        if (st) files.push({ p: r, size: st.size });
      }
    }
  }
  for (const root of ROOTS) await walk(dirs[root], root);
  return files;
}

/** Absolute path for a manifest path, or null when it points outside the data folders. */
export function resolveRel(dirs, rel) {
  const [root, ...rest] = String(rel || '').split('/');
  if (!ROOTS.includes(root) || !rest.length || rest.some((x) => !x || x === '.' || x === '..')) return null;
  const abs = path.resolve(dirs[root], ...rest);
  return abs.startsWith(path.resolve(dirs[root]) + path.sep) ? abs : null;
}

/** Old absolute data paths inside JSON (project clips point at library files) → this install's. */
export function rewritePaths(text, fromRoots, dirs) {
  let out = text;
  for (const root of ROOTS) {
    const from = fromRoots?.[root];
    if (!from || from === dirs[root]) continue;
    out = out.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(dirs[root]).slice(1, -1));
  }
  return out;
}

/**
 * Merge two copies of a settings/list file: lists of { id } are combined (this install wins on the
 * same id; on the same name — e.g. the "Autopilot" folder both made — the old one wins, since the
 * copied projects point at it).
 */
export function mergeJson(mine, theirs) {
  const byId = (x) => Array.isArray(x) && x.every((v) => v && typeof v === 'object' && 'id' in v);
  if (byId(mine) && byId(theirs)) {
    const theirNames = new Set(theirs.map((v) => v.name).filter(Boolean));
    const kept = mine.filter((v) => theirs.some((t) => t.id === v.id) || !theirNames.has(v.name));
    const have = new Set(kept.map((v) => v.id));
    return [...kept, ...theirs.filter((v) => !have.has(v.id))];
  }
  if (mine && theirs && typeof mine === 'object' && typeof theirs === 'object' && !Array.isArray(mine) && !Array.isArray(theirs)) {
    const out = { ...theirs }; // the old install's settings are the ones the creator set up
    for (const [k, v] of Object.entries(mine)) out[k] = k in theirs ? mergeJson(v, theirs[k]) : v;
    return out;
  }
  return theirs ?? mine;
}

const pretty = (code) => code.replace(/(.{4})(?=.)/g, '$1-');
const plain = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function createTransfer({ dirs, onChange = () => {}, onDone = () => {}, isBusy = () => false, log = console.log }) {
  // ---- the OLD install: hand out files to whoever has the code ----
  let code = null; // { value, until }
  let bad = [];
  function checkCode(req) {
    const now = Date.now();
    bad = bad.filter((t) => now - t < 10 * 60_000);
    if (bad.length >= 20) return { ok: false, status: 429, error: 'Too many wrong codes — wait 10 minutes.' };
    const given = plain(req.headers['x-transfer-code']);
    const ok = code && now < code.until && given.length === code.value.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(code.value));
    if (!ok) bad.push(now);
    return ok ? { ok: true } : { ok: false, status: 401, error: 'Wrong or expired transfer code — make a new one on the old ClipForge.' };
  }

  /** This install's address as seen from the internet, when we can tell (a codespace). */
  function publicUrl(req) {
    const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = process.env;
    if (name && domain) return `https://${name}-${process.env.PORT || 3000}.${domain}`;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return host ? `${req.headers['x-forwarded-proto'] || req.protocol}://${host}` : null;
  }

  // ---- the NEW install: pull everything ----
  let job = null;

  async function pull({ url, code: given }) {
    if (job?.state === 'running') throw Object.assign(new Error('A transfer is already running.'), { status: 409 });
    const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/(api|#).*$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(base)) throw Object.assign(new Error('Paste the old ClipForge’s address (https://…).'), { status: 400 });
    const headers = { 'x-transfer-code': plain(given) };
    const res = await fetch(`${base}/api/transfer/manifest`, { headers, redirect: 'manual' }).catch((err) => {
      throw Object.assign(new Error(`Could not reach the old ClipForge: ${err.cause?.code || err.message}`), { status: 400 });
    });
    if (res.status >= 300 && res.status < 400) {
      throw Object.assign(new Error('The old ClipForge isn’t open to the internet yet.'), {
        status: 400,
        hint: 'In the codespace: Ports tab → right-click port 3000 → Port Visibility → Public. Then try again.',
      });
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) throw Object.assign(new Error('That address isn’t a ClipForge (or it is too old — let it update first).'), { status: 400 });
    const m = await res.json();
    if (!res.ok) throw Object.assign(new Error(m.error || `The old ClipForge said ${res.status}.`), { status: 400 });

    // Already here with the same size → skipped (a re-run continues where it stopped).
    const todo = [];
    for (const f of m.files) {
      const abs = resolveRel(dirs, f.p);
      if (!abs) continue;
      const st = await fs.stat(abs).catch(() => null);
      if (!MERGE.has(f.p) && st && st.size === f.size) continue;
      todo.push({ ...f, abs });
    }
    const bytes = todo.reduce((n, f) => n + f.size, 0);
    const { free } = await diskFree(dirs.library);
    if (free != null && bytes > free - 2 * 1024 ** 3) {
      throw Object.assign(new Error(`Not enough disk space: the transfer needs ${(bytes / 1024 ** 3).toFixed(1)} GB, this computer has ${(free / 1024 ** 3).toFixed(1)} GB free.`), { status: 400 });
    }

    job = { state: 'running', from: base, files: todo.length, done: 0, bytes, doneBytes: 0, skipped: m.files.length - todo.length, failed: [], current: null, startedAt: Date.now(), abort: new AbortController() };
    const publicJob = () => ({ ...job, abort: undefined });
    let last = 0;
    const changed = (force) => {
      if (force || Date.now() - last > 700) {
        last = Date.now();
        onChange({ type: 'transfer', transfer: publicJob() });
      }
    };
    changed(true);

    const one = async (f) => {
      job.current = f.p.split('/').slice(-2).join('/');
      const tmp = `${f.abs}.transfer-tmp`;
      try {
        const r = await fetch(`${base}/api/transfer/file?p=${encodeURIComponent(f.p)}`, { headers, signal: job.abort.signal });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        await fs.mkdir(path.dirname(f.abs), { recursive: true });
        const count = new Transform({
          transform(chunk, _enc, cb) {
            job.doneBytes += chunk.length;
            changed();
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(r.body), count, fsSync.createWriteStream(tmp));
        if (f.p.endsWith('.json')) {
          let text = rewritePaths(await fs.readFile(tmp, 'utf8'), m.roots, dirs);
          if (MERGE.has(f.p)) {
            const mine = await fs.readFile(f.abs, 'utf8').then(JSON.parse).catch(() => null);
            if (mine) text = JSON.stringify(mergeJson(mine, JSON.parse(text)), null, 2);
          }
          await fs.writeFile(tmp, text);
        }
        await fs.rename(tmp, f.abs);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        if (job.abort.signal.aborted) throw err;
        job.failed.push(f.p);
      }
      job.done++;
      changed();
    };

    (async () => {
      // Small files (settings, scans, plans) first, so the library is usable while videos copy.
      const queue = [...todo].sort((a, b) => a.size - b.size);
      const workers = Array.from({ length: 3 }, async () => {
        while (queue.length && !job.abort.signal.aborted) await one(queue.shift());
      });
      try {
        await Promise.all(workers);
        job.state = job.abort.signal.aborted ? 'cancelled' : 'done';
      } catch {
        job.state = 'cancelled';
      }
      job.current = null;
      job.finishedAt = Date.now();
      log(`  Transfer from ${base}: ${job.done - job.failed.length}/${job.files} files${job.failed.length ? `, ${job.failed.length} failed` : ''}.`);
      changed(true);
      if (job.state === 'done') onDone(publicJob());
    })();
    return publicJob();
  }

  return {
    // OLD side
    makeCode(req) {
      const value = crypto.randomBytes(6).toString('hex');
      code = { value, until: Date.now() + CODE_TTL };
      return { code: pretty(value), url: publicUrl(req), expiresAt: code.until, codespace: Boolean(process.env.CODESPACE_NAME) };
    },
    /** In a codespace, try to open port 3000 to the internet (needs the gh CLI); true when it worked. */
    async openPort() {
      const name = process.env.CODESPACE_NAME;
      if (!name) return null;
      const r = await run('gh', ['codespace', 'ports', 'visibility', `${process.env.PORT || 3000}:public`, '-c', name], { timeoutMs: 30_000 }).catch(() => ({ code: 1 }));
      return r.code === 0;
    },
    async serveManifest(req, res) {
      const c = checkCode(req);
      if (!c.ok) return res.status(c.status).json({ error: c.error });
      const files = await buildManifest(dirs);
      res.json({ version: 1, roots: Object.fromEntries(ROOTS.map((r) => [r, dirs[r]])), files, busy: isBusy() || null });
    },
    serveFile(req, res) {
      const c = checkCode(req);
      if (!c.ok) return res.status(c.status).json({ error: c.error });
      const rel = String(req.query.p || '');
      const abs = resolveRel(dirs, rel);
      if (!abs || skipPath(rel)) return res.status(404).json({ error: 'Not part of the transfer.' });
      res.sendFile(abs, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'File not found.' });
      });
    },
    // NEW side
    pull,
    status: () => (job ? { ...job, abort: undefined } : null),
    cancel() {
      job?.abort.abort();
    },
  };
}

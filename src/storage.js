import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PipelineError } from './util.js';

/**
 * Disk space: what ClipForge uses, automatic clean-up of everything it can re-create, a guard that
 * stops a render before it fills the disk, and one-tap clean-ups for the rest.
 *
 * Re-creatable ("caches"): polished / stabilised clip copies, studio sound, slow motion, seekable
 * copies, blur backgrounds — per library video in library/<id>/cache. They're kept up to a budget,
 * least-recently-used first out. Leftovers (raw renders, half uploads, HyperFrames' render history)
 * are always deleted.
 */
const GB = 1024 ** 3;
const HOUR = 3600_000;

export async function dirSize(dir) {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function filesUnder(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await filesUnder(p, out);
    else if (e.isFile()) {
      const st = await fs.stat(p).catch(() => null);
      if (st) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

export async function diskFree(dir) {
  try {
    const s = await fs.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { free: null, total: null };
  }
}

/** Which cache files to delete (oldest first) to get under `budget` bytes. Exported for tests. */
export function pickEvictions(files, budget, { now = Date.now(), minAgeMs = HOUR } = {}) {
  let total = files.reduce((n, f) => n + f.size, 0);
  const out = [];
  for (const f of [...files].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= budget) break;
    if (now - f.mtime < minAgeMs) continue; // possibly in use by a render right now
    out.push(f);
    total -= f.size;
  }
  return out;
}

/** Cache budget: 12% of the disk, between 1 and 6 GB — less when the disk is nearly full. */
export function cacheBudget({ free, total }) {
  if (!total) return 3 * GB;
  const base = Math.min(6 * GB, Math.max(1 * GB, total * 0.12));
  return free != null && free < 4 * GB ? Math.min(base, 0.5 * GB) : base;
}

export function createStorage({ dirs, library, toolsDir, isBusy = () => false, home = os.homedir(), log = console.log }) {
  const hfHistory = path.join(home, '.cache', 'hyperframes', 'history');
  const cacheDirs = () => library.list().map((a) => library.cacheDir(a.id));

  async function cacheFiles() {
    const all = [];
    for (const d of cacheDirs()) await filesUnder(d, all);
    return all;
  }

  /** Leftovers nothing will ever use again. */
  async function sweepLeftovers() {
    let freed = 0;
    const rm = async (p) => {
      const st = await fs.stat(p).catch(() => null);
      if (!st) return;
      freed += st.isDirectory() ? await dirSize(p) : st.size;
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    };
    // HyperFrames keeps a ~15 MB "history" of every render it ever did.
    for (const e of await fs.readdir(hfHistory).catch(() => [])) await rm(path.join(hfHistory, e));
    if (!isBusy()) {
      // Raw (uncompressed) renders and re-edit leftovers.
      const subdirs = async (d) => (await fs.readdir(d, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
      for (const out of await subdirs(dirs.output)) {
        const d = path.join(dirs.output, out);
        if (out.endsWith('-prev')) await rm(d);
        else for (const f of await fs.readdir(d).catch(() => [])) if (f.endsWith('.raw.mp4')) await rm(path.join(d, f));
      }
      // Compositions left by a crash, link downloads, half-written temp files.
      for (const ws of await subdirs(dirs.workspace)) {
        await rm(path.join(dirs.workspace, ws, 'project'));
        if (ws === '_links') await rm(path.join(dirs.workspace, ws));
      }
    }
    // Uploads that never finished (a day old) and stale scratch files in the library's inbox.
    for (const f of await filesUnder(library.incoming)) if (Date.now() - f.mtime > 24 * HOUR) await rm(f.path);
    return freed;
  }

  async function pruneCaches(budget) {
    if (isBusy()) return 0;
    const files = await cacheFiles();
    let freed = 0;
    for (const f of pickEvictions(files, budget)) {
      await fs.rm(f.path, { force: true });
      await fs.rm(`${f.path}.json`, { force: true }); // sidecar metadata of polished copies
      freed += f.size;
    }
    return freed;
  }

  /** Everything automatic: leftovers + caches over budget. Returns bytes freed. */
  async function autoClean() {
    const disk = await diskFree(dirs.library);
    const freed = (await sweepLeftovers()) + (await pruneCaches(cacheBudget(disk)));
    if (freed > 50 * 1024 ** 2) log(`  Freed ${(freed / GB).toFixed(2)} GB of disk space (leftovers and old caches).`);
    return freed;
  }

  return {
    autoClean,
    /** Stop a render early (with a clear message) instead of failing halfway on a full disk. */
    async ensureSpace(needed = 1.5 * GB) {
      let { free } = await diskFree(dirs.library);
      if (free == null || free >= needed) return;
      await sweepLeftovers();
      await pruneCaches(0.25 * GB);
      ({ free } = await diskFree(dirs.library));
      if (free != null && free < needed) {
        throw new PipelineError(`The disk is almost full (${(free / GB).toFixed(1)} GB free).`, {
          hint: 'Open “Free up space” in the sidebar — delete old Autopilot batches, renders or videos you no longer need.',
        });
      }
    },
    /** What uses the disk, by category (bytes). */
    async report() {
      const assets = library.list();
      const generated = assets.filter((a) => a.generated);
      const caches = (await cacheFiles()).reduce((n, f) => n + f.size, 0);
      const autopilot = await dirSize(path.join(dirs.output, '_autopilot'));
      const [output, workspace, uploads, tools, hfCache, npmCache, pipCache, uvCache] = await Promise.all([
        dirSize(dirs.output), dirSize(dirs.workspace), dirSize(dirs.uploads), dirSize(toolsDir),
        dirSize(path.join(home, '.cache', 'hyperframes')), dirSize(path.join(home, '.npm', '_cacache')),
        dirSize(path.join(home, '.cache', 'pip')), dirSize(path.join(home, '.cache', 'uv')),
      ]);
      return {
        ...(await diskFree(dirs.library)),
        categories: {
          videos: assets.filter((a) => a.kind === 'video').reduce((n, a) => n + a.size, 0),
          music: assets.filter((a) => a.kind === 'audio' && !a.generated).reduce((n, a) => n + a.size, 0),
          generatedMusic: generated.reduce((n, a) => n + a.size, 0),
          caches,
          renders: Math.max(0, output - autopilot),
          autopilot,
          work: workspace + uploads,
          tools,
          system: npmCache + pipCache + uvCache + (await dirSize(hfHistory)),
          browser: Math.max(0, hfCache - (await dirSize(hfHistory))),
        },
        generatedMusicCount: generated.length,
      };
    },
    /** One-tap clean-ups. */
    async clean(what, { days = 14 } = {}) {
      const before = (await diskFree(dirs.library)).free;
      if (what === 'caches') {
        await sweepLeftovers();
        await pruneCaches(0);
      } else if (what === 'system') {
        for (const d of [path.join(home, '.npm', '_cacache'), path.join(home, '.cache', 'pip'), path.join(home, '.cache', 'uv'), hfHistory]) {
          await fs.rm(d, { recursive: true, force: true });
        }
      } else if (what === 'models') {
        await fs.rm(path.join(toolsDir, 'ml', 'models'), { recursive: true, force: true });
      } else if (what === 'generatedMusic') {
        for (const a of library.list().filter((x) => x.generated)) await library.remove(a.id).catch(() => {});
      } else if (what !== 'leftovers') {
        throw Object.assign(new Error('Unknown clean-up.'), { status: 400 });
      } else {
        await sweepLeftovers();
      }
      const after = (await diskFree(dirs.library)).free;
      return { freed: before != null && after != null ? Math.max(0, after - before) : null, days };
    },
  };
}

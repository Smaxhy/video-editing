import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Folders to organise the work: each folder can hold projects and library items (videos, music).
 * Items point at their folder (job.folder / asset.folder); this store only keeps the folder list.
 */
export const FOLDER_COLORS = ['#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#a3a3a3'];
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Validate a folder patch. Exported for tests. */
export function normalizeFolder(raw = {}, prev = null) {
  const name = raw.name === undefined ? prev?.name : clean(raw.name);
  if (!name) throw Object.assign(new Error('Give the folder a name.'), { status: 400 });
  const color = FOLDER_COLORS.includes(raw.color) ? raw.color : prev?.color || FOLDER_COLORS[0];
  return { name, color };
}

export function createFolders({ file }) {
  let folders = [];
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ folders }, null, 2));
    await fs.rename(`${file}.tmp`, file);
  };
  const sorted = () => [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    async load() {
      try {
        folders = JSON.parse(await fs.readFile(file, 'utf8')).folders || [];
      } catch {
        folders = [];
      }
    },
    list: sorted,
    get: (id) => folders.find((f) => f.id === id) || null,
    has: (id) => folders.some((f) => f.id === id),
    async create(raw) {
      const f = { id: crypto.randomBytes(6).toString('hex'), ...normalizeFolder(raw, { color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length] }), createdAt: Date.now() };
      folders.push(f);
      await save();
      return f;
    },
    /** The folder with this name, created if missing (used by Autopilot). */
    async ensure(name, color) {
      return folders.find((f) => f.name.toLowerCase() === name.toLowerCase()) || this.create({ name, color });
    },
    async update(id, raw) {
      const f = folders.find((x) => x.id === id);
      if (!f) return null;
      Object.assign(f, normalizeFolder(raw, f));
      await save();
      return f;
    },
    async remove(id) {
      const before = folders.length;
      folders = folders.filter((f) => f.id !== id);
      if (folders.length !== before) await save();
      return folders.length !== before;
    },
  };
}

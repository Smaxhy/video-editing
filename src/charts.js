import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Popular songs right now, for "which sound should I post this with?". Free public charts, no key:
 * Deezer's global chart (with 30-second previews), falling back to Apple Music's most-played feed.
 * Cached on disk for 12 hours; when the internet is unreachable the last list is used.
 * Each song: { id: 'c1', title, artist, preview (mp3 url or null), link, explicit }.
 */
const TTL = 12 * 3600_000;
const SOURCES = [
  {
    name: 'Deezer chart',
    url: 'https://api.deezer.com/chart/0/tracks?limit=100',
    parse: (j) => (j?.data || []).map((t) => ({
      title: t.title_short || t.title,
      artist: t.artist?.name || '',
      preview: t.preview || null,
      link: t.link || null,
      explicit: Boolean(t.explicit_lyrics),
    })),
  },
  {
    name: 'Apple Music most played',
    url: 'https://rss.applemarketingtools.com/api/v2/us/music/most-played/100/songs.json',
    parse: (j) => (j?.feed?.results || []).map((t) => ({
      title: t.name,
      artist: t.artistName || '',
      preview: null,
      link: t.url || null,
      explicit: t.contentAdvisoryRating === 'Explicit',
    })),
  },
];

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90);

export function createCharts({ cacheFile, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console.log }) {
  let memo = null;

  async function load() {
    for (const src of SOURCES) {
      try {
        const res = await fetchImpl(src.url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const seen = new Set();
        const songs = src.parse(await res.json())
          .map((t) => ({ ...t, title: clean(t.title), artist: clean(t.artist) }))
          .filter((t) => t.title && t.artist && !seen.has(`${t.title}|${t.artist}`.toLowerCase()) && seen.add(`${t.title}|${t.artist}`.toLowerCase()))
          .slice(0, 80)
          .map((t, i) => ({ id: `c${i + 1}`, ...t }));
        if (songs.length >= 10) return { at: now(), source: src.name, songs };
      } catch (err) {
        log(`  Charts: ${src.name} unavailable (${err.message}).`);
      }
    }
    return null;
  }

  return {
    /** { at, source, songs } — fresh, cached or stale; null when there has never been a list. */
    async top() {
      if (memo && now() - memo.at < TTL) return memo;
      const disk = JSON.parse(await fs.readFile(cacheFile, 'utf8').catch(() => 'null'));
      if (disk?.songs?.length && now() - disk.at < TTL) return (memo = disk);
      const fresh = await load();
      if (fresh) {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(fresh)).catch(() => {});
        return (memo = fresh);
      }
      // Offline: an older list is still better than none (retry in an hour).
      if (disk?.songs?.length) return (memo = { ...disk, at: now() - TTL + 3600_000, stale: true });
      return null;
    },
  };
}

/** The planner's picks ("sound.popular": [{ track: "c7", why, part }]) → real chart songs. */
export function matchPopular(raw, songs) {
  const byId = new Map((songs || []).map((s) => [s.id, s]));
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    const s = byId.get(String(p?.track || '').trim());
    if (!s || out.some((o) => o.title === s.title && o.artist === s.artist)) continue;
    out.push({ title: s.title, artist: s.artist, preview: s.preview, link: s.link, explicit: s.explicit, why: clean(p.why).slice(0, 140), part: clean(p.part).slice(0, 80) });
  }
  return out.slice(0, 5);
}

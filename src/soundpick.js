/**
 * "Put <this sound> under it": find the track the user means in their own words — by its title
 * ("use My Summer Song"), by recency ("the sound I imported last"), or by description ("the
 * phonk one", "something calm") using what ClipForge heard in each track. Returns
 * { id, name, why } or null when the text doesn't ask for a particular sound.
 */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\.(m4a|mp3|wav|aac|ogg|flac|mp4|mov|webm)\b/g, ' ').replace(/\(sound\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'with', 'this', 'that', 'sound', 'song', 'music', 'track', 'audio', 'video', 'my', 'of', 'from', 'remix', 'edit', 'official', 'version']);
const SOUND_WORDS = /\b(sound|song|music|track|audio|beat|tune|bgm)\b/;
const VOCAB = new Set(('hip hop rap drill trap phonk lofi lo fi pop edm house techno dubstep rock metal punk acoustic guitar piano '
  + 'cinematic orchestral jazz rnb soul funk disco country classical reggaeton afrobeats afro latin kpop ambient synthwave '
  + 'energetic aggressive happy sad calm epic dark motivational funny romantic nostalgic tense chill hype upbeat emotional '
  + 'dreamy relaxing peaceful intense powerful playful quirky melancholic uplifting slowed sped').split(' '));

export function trackFromText(text, tracks) {
  const t = norm(text);
  if (!t || !tracks?.length) return null;
  // 1. A title in the text (whole name, or all of its distinctive words).
  let best = null;
  for (const tr of tracks) {
    const names = [tr.name, tr.title].filter(Boolean).map(norm).filter(Boolean);
    for (const n of names) {
      const words = n.split(' ').filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
      const whole = n.length >= 4 && ` ${t} `.includes(` ${n} `);
      const hits = words.filter((w) => ` ${t} `.includes(` ${w} `)).length;
      const score = whole ? 100 + n.length : words.length && hits === words.length ? 50 + hits : hits >= 2 ? 20 + hits : 0;
      if (score && (!best || score > best.score)) best = { score, tr };
    }
  }
  if (best) return { id: best.tr.id, name: best.tr.name, why: 'named in your request' };
  if (!SOUND_WORDS.test(t)) return null;
  // 2. "the last / newest / latest sound I imported".
  if (/\b(last|latest|newest|most recent|recently (added|imported|uploaded|saved)|just (added|imported|uploaded|saved|put))\b/.test(t)) {
    const tr = [...tracks].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    return { id: tr.id, name: tr.name, why: 'the newest sound in your library' };
  }
  // 3. A description: genre / mood / energy words that match what ClipForge heard in a track.
  let desc = null;
  for (const tr of tracks) {
    const heard = norm(`${tr.heard || ''} ${tr.tags || ''}`);
    // Only real music words count ("phonk", "calm", "piano") — not "background" or "nice".
    const words = heard.split(' ').filter((w) => VOCAB.has(w));
    const hits = [...new Set(words)].filter((w) => ` ${t} `.includes(` ${w} `)).length;
    if (hits && (!desc || hits > desc.hits)) desc = { hits, tr };
  }
  return desc ? { id: desc.tr.id, name: desc.tr.name, why: 'matches the sound you described' } : null;
}

import { round } from './util.js';

/**
 * The editor's checklist — the last look a human editor gives a cut before it goes out. It fixes
 * the things that make a video read as "made by an app":
 *   - stock phrases nobody would type themselves ("Wait for it", "You won't believe…")
 *   - emojis and decoration in on-screen text
 *   - too much text (a label on every shot)
 *   - a hook that shows up late, text too short to read, text that runs past the end
 *   - organic videos that fade in from black or drift out on a slow fade
 * What the user asked for explicitly always stays (their own words are quoted in `said`).
 */
const STOCK = [
  /\bwait for it\b/i, /\byou won'?t believe\b/i, /\bwatch (?:till|until|to) the end\b/i, /\bgame[- ]?changer\b/i,
  /\bnext[- ]level\b/i, /\bhere'?s the thing\b/i, /\blet'?s dive in\b/i, /\bin today'?s video\b/i, /\bsatisfying\b/i,
  /\bmind[- ]?blown\b/i, /\bthis changes everything\b/i, /\bstay tuned\b/i, /\bthe results? (?:will )?(?:shock|amaze)\b/i,
  /\byou need to see this\b/i, /\bdon'?t miss\b/i, /\blike and (?:follow|subscribe)\b/i, /\belevate your\b/i,
  /\bthanks for watching\b/i,
];
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Seconds a line needs on screen to be read comfortably. */
export const readTime = (text) => Math.max(1.2, 0.6 + 0.32 * String(text || '').split(/\s+/).filter(Boolean).length);

/**
 * Returns { plan, fixes: [human-readable strings] }.
 * opts: total (output seconds), goal ('social' | 'ad' | 'both'), said (everything the user wrote),
 * intensity, keepText (the user asked for text / subtitles as overlays).
 */
export function lintPlan(plan, { total, goal = 'social', said = '', intensity = 'natural', keepText = false } = {}) {
  const fixes = [];
  const userSaid = norm(said);
  const asked = (text) => {
    const t = norm(text);
    return t.length >= 4 && userSaid.includes(t);
  };
  const wantsEmoji = (/\bemojis?\b/i.test(said) && !/\bno emojis?\b/i.test(said)) || EMOJI.test(said);
  EMOJI.lastIndex = 0;
  let overlays = (plan.overlays || []).map((o) => ({ ...o }));

  // 1. Emojis and stock phrases.
  let emojis = 0;
  const stock = [];
  overlays = overlays.filter((o) => {
    if (!wantsEmoji) {
      for (const k of ['text', 'subtext']) {
        const clean = String(o[k] || '').replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
        if (clean !== String(o[k] || '').trim()) emojis++;
        o[k] = clean;
      }
    }
    if (!o.text) return false;
    // The user's own words stay, stock phrase or not.
    if (o.type !== 'cta' && !asked(o.text) && STOCK.some((re) => re.test(o.text))) {
      stock.push(o.text);
      return false;
    }
    return true;
  });
  if (emojis) fixes.push(`took ${emojis} emoji${emojis > 1 ? 's' : ''} out of the on-screen text`);
  if (stock.length) fixes.push(`dropped ${stock.length} stock line${stock.length > 1 ? 's' : ''} (“${stock[0]}”${stock.length > 1 ? '…' : ''})`);

  // 2. The hook is on screen from the first frame.
  const hook = overlays.find((o) => o.type === 'hook');
  if (hook && hook.start > 0 && hook.start <= 1.2) {
    hook.end = round(hook.end - hook.start, 3);
    hook.start = 0;
    fixes.push('put the hook on the first frame');
  }

  // 3. Not a label on every shot: at most one text every ~5 s (styled levels: ~3.5 s), unless the
  //    user asked for text / subtitles. The hook, the CTA and the user's own lines always stay.
  if (!keepText && total) {
    const budget = Math.max(1, Math.floor(total / (['creator', 'max'].includes(intensity) ? 3.5 : 5)));
    const fixed = overlays.filter((o) => o.type === 'hook' || o.type === 'cta' || o.type === 'lower-third' || asked(o.text));
    const rest = overlays.filter((o) => !fixed.includes(o));
    const room = Math.max(0, budget - fixed.length);
    if (rest.length > room) {
      // Keep the ones spread most evenly over the video.
      const keep = new Set();
      for (let k = 0; k < room; k++) keep.add(rest[Math.round(((k + 0.5) * rest.length) / room - 0.5)]);
      fixes.push(`cut ${rest.length - keep.size} extra text${rest.length - keep.size > 1 ? 's' : ''} so the picture can breathe`);
      overlays = overlays.filter((o) => fixed.includes(o) || keep.has(o));
    }
  }

  // 4. Readable: long enough for its words, inside the video.
  overlays.sort((a, b) => a.start - b.start);
  let stretched = 0;
  overlays.forEach((o, i) => {
    if (o.type === 'cta') return;
    const next = overlays.slice(i + 1).find((n) => n.type !== 'lower-third' || o.type === 'lower-third');
    const limit = Math.min(total || Infinity, next ? next.start : Infinity);
    const need = readTime(o.text);
    if (o.end - o.start < need && limit - o.start > o.end - o.start + 0.1) {
      o.end = round(Math.min(limit, o.start + need), 3);
      stretched++;
    }
  });
  if (stretched) fixes.push(`kept ${stretched} text${stretched > 1 ? 's' : ''} up long enough to read`);
  if (total) overlays = overlays.map((o) => ({ ...o, end: Math.min(o.end, total) })).filter((o) => o.end - o.start >= 0.4);

  // 5. Organic social starts hard and ends on the payoff: no fade from black, no long fade-out.
  const scenes = plan.scenes.map((s) => ({ ...s }));
  const audio = { ...(plan.audio || {}) };
  if (goal !== 'ad') {
    if (scenes[0] && ['fadeblack', 'crossfade'].includes(scenes[0].transition)) {
      scenes[0].transition = 'cut';
      scenes[0].transitionDuration = 0;
      fixes.push('opens on a hard cut instead of a fade');
    }
    if (audio.fadeIn > 0.15) audio.fadeIn = 0;
    if (audio.fadeOut > 0.6) audio.fadeOut = 0.4;
  }
  return { plan: { ...plan, scenes, overlays, audio }, fixes };
}

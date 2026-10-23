import { layoutTimeline } from './renderer.js';
import { round } from './util.js';

/**
 * Auto-tighten: the "Smart Trim" pass pro editors do by hand. Inside every talking scene, pauses
 * longer than MAX_GAP between words and filler words ("um", "uh"…) are cut out, leaving a little
 * breathing room on each side. Scenes without speech (B-roll, POV) are never touched. Overlays are
 * moved so they stay on the same words.
 */
const MAX_GAP = 0.45; // longer pauses get cut
const PAD_BEFORE = 0.08; // keep this much before a word starts
const PAD_AFTER = 0.15; // and this much after it ends (lets the last syllable ring out)
const MIN_PIECE = 0.25;
const FILLER = /^(u+[hm]+|e+r+m*|h*m{2,}|a+h+|e+h+|u+m+h*)[,.!?…]*$/i;

const isFiller = (w) => FILLER.test(String(w.word || '').trim());

/** Source ranges to keep inside [start, end) of one clip, given its words. */
export function keepRanges(words, start, end, { maxGap = MAX_GAP } = {}) {
  const inside = words.filter((w) => w.end > start && w.start < end);
  const speech = inside.filter((w) => !isFiller(w));
  // Not a talking scene (B-roll, POV, music) — keep it exactly as planned.
  const spoken = speech.reduce((n, w) => n + Math.min(w.end, end) - Math.max(w.start, start), 0);
  if (speech.length < 3 || spoken < (end - start) * 0.35) return [[start, end]];

  const ranges = [];
  let cur = [start, Math.min(end, speech[0].end + PAD_AFTER)];
  // Leading silence before the first word is trimmed too (keeps the planner's start if it's tight).
  if (speech[0].start - start > maxGap) cur[0] = Math.max(start, speech[0].start - PAD_BEFORE);
  for (let i = 1; i < speech.length; i++) {
    const prev = speech[i - 1];
    const w = speech[i];
    const gap = w.start - prev.end;
    const fillerBetween = inside.some((f) => isFiller(f) && f.start >= prev.end - 0.01 && f.end <= w.start + 0.01);
    if (gap > maxGap || (fillerBetween && gap > 0.15)) {
      cur[1] = Math.min(end, prev.end + PAD_AFTER);
      ranges.push(cur);
      cur = [Math.max(start, w.start - PAD_BEFORE), Math.min(end, w.end + PAD_AFTER)];
    } else {
      cur[1] = Math.min(end, w.end + PAD_AFTER);
    }
  }
  const last = speech[speech.length - 1];
  // Trailing silence after the last word is trimmed the same way.
  cur[1] = end - last.end > maxGap ? Math.min(end, last.end + PAD_AFTER) : end;
  ranges.push(cur);
  return ranges.filter(([a, b]) => b - a >= MIN_PIECE).map(([a, b]) => [round(a, 3), round(b, 3)]);
}

/** Split talking scenes around pauses and fillers; returns { plan, removed } (seconds cut). */
export function tightenPlan(plan, transcripts, { maxGap = MAX_GAP } = {}) {
  const before = layoutTimeline(plan);
  const scenes = [];
  const pieces = []; // per original scene: [{ index in new scenes, srcStart, srcEnd }]
  plan.scenes.forEach((s) => {
    const t = transcripts[s.clip];
    const words = t?.words?.length ? t.words : [];
    const keep = s.speed === 1 && words.length ? keepRanges(words, s.start, s.end, { maxGap }) : [[s.start, s.end]];
    const mine = [];
    keep.forEach(([a, b], k) => {
      mine.push({ index: scenes.length, srcStart: a, srcEnd: b });
      scenes.push(k === 0 ? { ...s, start: a, end: b } : { ...s, start: a, end: b, transition: 'cut', transitionDuration: 0, jump: true });
    });
    pieces.push(mine);
  });
  const next = { ...plan, scenes };
  const after = layoutTimeline(next);

  // Old output time → new output time (a time inside a removed pause snaps to the next kept piece).
  const remap = (t) => {
    const i = before.scenes.findIndex((sc) => t < sc.tlStart + sc.duration) ;
    const sc = before.scenes[i === -1 ? before.scenes.length - 1 : i];
    const src = sc.srcStart + Math.max(0, t - sc.tlStart) * sc.speed;
    for (const p of pieces[sc.index]) {
      const nsc = after.scenes[p.index];
      if (src < p.srcStart) return nsc.tlStart;
      if (src <= p.srcEnd) return nsc.tlStart + (src - p.srcStart) / nsc.speed;
    }
    const lastPiece = pieces[sc.index][pieces[sc.index].length - 1];
    const nsc = after.scenes[lastPiece.index];
    return nsc.tlStart + nsc.duration;
  };
  const overlays = plan.overlays
    .map((o) => {
      // CTA end cards stay pinned to the end of the video.
      if (o.type === 'cta' && o.end >= before.total - 0.1) {
        const len = o.end - o.start;
        return { ...o, start: round(Math.max(0, after.total - len), 3), end: round(after.total, 3) };
      }
      const start = round(remap(o.start), 3);
      const end = round(Math.max(remap(o.end), start + Math.min(1.2, o.end - o.start)), 3);
      return { ...o, start, end: Math.min(end, round(after.total, 3)) };
    })
    .filter((o) => o.end - o.start >= 0.2);
  return { plan: { ...next, overlays }, removed: round(before.total - after.total, 2) };
}

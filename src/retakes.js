/**
 * Retakes and false starts. People repeat a line until it comes out right; an editor keeps the last
 * good take and throws the rest away. This finds, in a clip's transcript:
 *   - retakes: the same sentence said again shortly after ("So today we're… So today we're going to cut it")
 *   - false starts: a few words, then the sentence starts over ("We have a — we have a dead aspen here")
 * Returns [{ drop: [start, end], keep: [start, end], text }] in SOURCE seconds — `drop` is the
 * earlier attempt. The planner is told about them and, when both ended up in the edit, the earlier
 * one is cut out.
 */
const norm = (w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Split words into phrases at sentence punctuation or pauses over 0.6 s. */
export function phrases(words) {
  const out = [];
  let cur = [];
  for (const w of words || []) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.6 || /[.!?…]["')]?$/.test(String(prev.word).trim()))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => ({
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    tokens: ws.map((w) => norm(w.word)).filter(Boolean),
    text: ws.map((w) => String(w.word).trim()).join(' '),
    closed: /[.!?]["')]?$/.test(String(ws[ws.length - 1].word).trim()),
  })).filter((p) => p.tokens.length);
}

/** Share of `a`'s tokens that appear in `b` in the same order (longest common subsequence / |a|). */
function coverage(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  return dp[a.length][b.length] / a.length;
}

export function findRetakes(words) {
  const ps = phrases(words);
  const out = [];
  for (let i = 0; i < ps.length - 1; i++) {
    const a = ps[i];
    // The next attempt follows within two phrases and 12 seconds.
    for (let j = i + 1; j <= Math.min(ps.length - 1, i + 2); j++) {
      const b = ps[j];
      if (b.start - a.end > 12) break;
      const sameStart = a.tokens.length >= 2 && a.tokens.slice(0, Math.min(3, a.tokens.length)).every((t, k) => b.tokens[k] === t);
      // Retake: (almost) the whole earlier sentence is said again.
      // (Short sentences must match almost word for word: "It leans toward the roof" / "…the road" are two thoughts.)
      const retake = a.tokens.length >= 4 && coverage(a.tokens, b.tokens) >= (a.tokens.length < 8 ? 0.9 : 0.8) && b.tokens.length >= a.tokens.length * 0.8;
      // False start: a short unfinished run whose words open the next phrase.
      const falseStart = !a.closed && a.tokens.length >= 2 && a.tokens.length <= 6 && sameStart && b.tokens.length > a.tokens.length && b.start - a.end < 3;
      if (retake || falseStart) {
        out.push({ drop: [a.start, a.end], keep: [b.start, b.end], text: a.text.slice(0, 80), kind: retake ? 'retake' : 'false start' });
        break;
      }
    }
  }
  return out;
}

/**
 * Cut earlier attempts out of the plan when the keeper is in it too (or always, for false starts —
 * nobody wants half a sentence). Scenes are trimmed or split around the dropped range.
 * retakes(clip) → findRetakes() result. Returns { plan, removed: [texts] }.
 */
export function dropRetakes(plan, retakes) {
  const removed = [];
  let scenes = plan.scenes;
  const clipIds = [...new Set(scenes.map((s) => s.clip))];
  for (const clip of clipIds) {
    for (const r of retakes(clip) || []) {
      const [d0, d1] = r.drop;
      const covers = (s, [a, b]) => s.clip === clip && s.speed === 1 && Math.min(s.end, b) - Math.max(s.start, a) > (b - a) * 0.6;
      const hasDrop = scenes.some((s) => covers(s, r.drop));
      const hasKeep = scenes.some((s) => covers(s, r.keep));
      if (!hasDrop || (!hasKeep && r.kind !== 'false start')) continue;
      const next = [];
      for (const s of scenes) {
        if (!covers(s, r.drop)) {
          next.push(s);
          continue;
        }
        // Keep what the scene has before and after the dropped attempt (if it is worth keeping).
        const before = { ...s, end: Math.max(s.start, d0 - 0.05) };
        const after = { ...s, start: Math.min(s.end, d1 + 0.05), transition: 'cut', transitionDuration: 0, peak: false };
        if (before.end - before.start >= 0.4) next.push(before);
        if (after.end - after.start >= 0.4) next.push(before.end - before.start >= 0.4 ? after : { ...after, transition: s.transition, transitionDuration: s.transitionDuration, ...(s.peak ? { peak: true } : {}) });
      }
      if (next.length) {
        scenes = next;
        removed.push(r.text);
      }
    }
  }
  return { plan: { ...plan, scenes }, removed };
}

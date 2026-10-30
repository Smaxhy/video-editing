/**
 * The user's words beat ClipForge's automatic passes. After Claude plans the edit, ClipForge can
 * re-cut it to the beat, add styled transitions / punch-ins / shakes, ramp into slow motion and add
 * a finishing pack (word-by-word text, opening hit, grain). Each of those may undo what the user
 * asked for ("keep the clips in order", "no slow-mo", "simple cuts"), so:
 *   1. Claude says in the plan's "auto" block which passes may run (it read the request), and
 *   2. explicit phrases in the request switch passes off no matter what (a safety net).
 */
export const AUTO_PASSES = {
  beatEdit: 'Re-cut the whole video to the song’s beat (re-orders and re-times shots, slow-motion hit on the drop)',
  beatSnap: 'Nudge cut points (≤0.35 s) onto the beat',
  styling: 'Add styled transitions, punch-ins and a flash + shake on the peak',
  slowmo: 'Ramp into slow-motion scenes',
  finish: 'Finishing pack: word-by-word text, an opening zoom hit, film grain / vignette',
};
/** Short names for the notes under the video. */
export const AUTO_LABELS = { beatEdit: 'beat re-cut', beatSnap: 'beat snapping', styling: 'extra transitions and effects', slowmo: 'slow-motion ramps', finish: 'animated text and grain' };
const ALL_ON = Object.fromEntries(Object.keys(AUTO_PASSES).map((k) => [k, true]));

const NEG = String.raw`(?:no|without|don'?t(?: add| use| put)?|do not(?: add| use| put)?|stop(?: adding| using)?|remove|get rid of|skip|turn off|lose the|zero|never|not? any|less|fewer|too many|too much)`;
const near = (words) => new RegExp(String.raw`\b${NEG}\b[^.!?\n]{0,30}?\b(?:${words})`, 'i');

const RULES = [
  { off: ['slowmo', 'beatEdit'], why: 'you said no slow motion', re: near(String.raw`slow[- ]?mo(?:tion)?s?|slowed|slow down`) },
  { off: ['styling'], why: 'you asked for fewer effects', re: near(String.raw`effects?|fx|transitions?|zoom(?:s|ing)?|punch[- ]?ins?|shak(?:e|es|ing)|flash(?:es)?|glitch(?:es)?|whips?|spins?`) },
  { off: ['styling', 'beatEdit', 'finish'], why: 'you asked for a simple edit', re: /\b(?:simple|plain|clean|basic|straight|minimal|natural|subtle)\s+(?:cuts?|edit(?:ing)?|video|style)\b|\bjust (?:cut|trim|put)\b|\bnothing fancy\b|\bkeep it (?:simple|clean|minimal|natural|raw)\b/i },
  { off: ['beatEdit'], why: 'you set the order', re: /\b(?:in (?:this|that|the same|the right|chronological|that exact|this exact) order|keep (?:the|my|their) order|same order|chronological(?:ly)?|in order|one after (?:the )?other|first[^.!?\n]{1,60}\bthen\b|order (?:of|as) (?:the )?(?:clips|uploads?|i (?:uploaded|added)))\b/i },
  { off: ['beatEdit', 'beatSnap'], why: 'you set the timing', re: /\b\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\s+(?:each|per|for each|of each)\b|\beach (?:clip|shot|scene|part)\b[^.!?\n]{0,25}\b\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\b|\bfrom \d+(?::\d+)?(?:\.\d+)?\s*(?:s|secs?|seconds?)? to \d/i },
  { off: ['beatEdit'], why: 'you asked to use whole clips', re: /\b(?:don'?t|do not|no)\b[^.!?\n]{0,20}\b(?:cut|chop|trim|shorten|split)\b[^.!?\n]{0,20}\b(?:clips?|shots?|scenes?|videos?)\b|\b(?:whole|full|entire|complete) (?:clips?|videos?|shots?)\b/i },
  { off: ['beatEdit', 'styling'], why: 'you asked for a calm, slow pace', re: /\b(?:slow(?:er)? (?:pace|paced|cuts|edit)|calm(?:er)? (?:pace|edit|cuts)|fewer cuts|less cuts|longer (?:shots|clips|scenes)|not so fast|too fast|too many cuts|too choppy|let (?:it|the shots?|the clips?) breathe)\b/i },
  { off: ['finish'], why: 'you asked for plain text / no grain', re: near(String.raw`grain|vignette|film look|animated text|word[- ]by[- ]word|text animation`) },
  { off: ['finish'], why: 'you asked for plain text', re: /\b(?:plain|simple|static|normal) (?:text|titles?|captions?)\b/i },
];

/** Which passes the request's own words switch off: { off: {pass: why}, noSlowmo }. Exported for tests. */
export function directivesFromText(text) {
  const t = String(text || '').replace(/[’`]/g, "'");
  const off = {};
  for (const r of RULES) if (r.re.test(t)) for (const k of r.off) off[k] ||= r.why;
  return { off, noSlowmo: Boolean(off.slowmo && RULES[0].re.test(t)) };
}

/** Claude's "auto" block, made safe: booleans only, missing → previous or on. */
export function normalizeAuto(raw, previous = null) {
  const base = { ...ALL_ON, ...(previous || {}) };
  if (!raw || typeof raw !== 'object') return base;
  for (const k of Object.keys(AUTO_PASSES)) if (typeof raw[k] === 'boolean') base[k] = raw[k];
  return base;
}

/**
 * The passes that may run: Claude's call AND the request's explicit words. Returns
 * { auto, skipped: [{ pass, why }], noSlowmo }.
 */
export function resolveAuto(claudeAuto, text) {
  const auto = normalizeAuto(claudeAuto);
  const d = directivesFromText(text);
  const skipped = [];
  for (const k of Object.keys(AUTO_PASSES)) {
    if (d.off[k]) {
      skipped.push({ pass: k, why: d.off[k] });
      auto[k] = false;
    } else if (!auto[k]) skipped.push({ pass: k, why: null }); // Claude's call from the request
  }
  return { auto, skipped, noSlowmo: d.noSlowmo };
}

/** "No slow motion": every scene plays at normal speed or faster. */
export function removeSlowMo(plan, clipDuration = () => Infinity) {
  let changed = 0;
  const scenes = plan.scenes.map((s) => {
    if (s.speed >= 1) return s;
    changed++;
    // Keep the shot's output length where the clip has the footage: more of it at normal speed.
    const outLen = (s.end - s.start) / s.speed;
    const end = Math.min(clipDuration(s.clip) || Infinity, s.start + outLen);
    return { ...s, speed: 1, end: Math.round(Math.max(end, s.end) * 1000) / 1000 };
  });
  return { plan: { ...plan, scenes }, changed };
}

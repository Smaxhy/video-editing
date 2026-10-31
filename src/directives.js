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

/**
 * Render settings the request's own words decide — whatever the menus say. Texts are read in order
 * (original request, then each fix), so a later "add music back" beats an earlier "no music".
 * Returns { patch, reasons } with patch keys: music ('auto' | 'off'), trendingSound, aiMusic,
 * musicLevel, voiceover, sfx, captions.
 */
const SOUNDS = String.raw`music|song|songs|track|soundtrack|beat|tune|audio|bgm|instrumental`;
const STRONG_NEG = String.raw`(?:no|without|remove|get rid of|turn off|take out|mute|drop|don'?t (?:add|use|want|put|need)|do not (?:add|use|want|put)|stop (?:adding|using|the))`;
const SETTING_RULES = [
  {
    re: new RegExp(String.raw`\b${STRONG_NEG}\b[^.!?\n]{0,20}?\b(?:(?:background )?(?:${SOUNDS}))\b`, 'i'),
    patch: { music: 'off' },
    why: 'no music',
    // A complaint that music is missing, not a request to remove it.
    unless: /\b(?:there(?:'s| is| was)|still|but|it has|the video has|i hear|i got) no (?:background )?(?:music|song|soundtrack|audio)\b|\bno (?:music|song|audio) (?:in (?:it|the video|there)|is playing|was (?:added|playing)|there)\b|\bisn'?t any (?:music|song)\b/i,
  },
  {
    re: new RegExp(String.raw`\b(?:add|put|use|want|need|include|play|with|under(?:neath)?|keep|bring back|give it|needs?)\b[^.!?\n]{0,40}?\b(?:${SOUNDS})\b|\b(?:background|backing) (?:${SOUNDS})\b|\b(?:${SOUNDS}) (?:in|under|behind|on|over) (?:the |it|this|everything)|\bthere(?:'s| is) no (?:${SOUNDS})\b|\b(?:${SOUNDS}) (?:is )?(?:missing|not there|gone|not playing)\b|\bcan'?t hear the (?:${SOUNDS})\b`, 'i'),
    patch: { music: 'auto', trendingSound: false, aiMusic: true },
    why: 'you asked for music',
  },
  { re: /\b(?:music|song|track|beat)\b[^.!?\n]{0,15}\b(?:louder|higher|up|more audible|too (?:quiet|low|soft))\b|\b(?:louder|turn up|raise|boost)\b[^.!?\n]{0,15}\b(?:the )?(?:music|song|track|beat)\b|\bcan'?t hear the (?:music|song|track|beat)\b/i, patch: { musicLevel: 'high' }, why: 'music louder' },
  { re: /\b(?:music|song|track|beat)\b[^.!?\n]{0,15}\b(?:quieter|lower|softer|down|too (?:loud|high))\b|\b(?:quieter|turn down|lower)\b[^.!?\n]{0,15}\b(?:the )?(?:music|song|track|beat)\b/i, patch: { musicLevel: 'low' }, why: 'music quieter' },
  { re: new RegExp(String.raw`\b${STRONG_NEG}\b[^.!?\n]{0,20}?\b(?:voice[- ]?overs?|narrat(?:ion|or)|ai voice|the voice|robot voice)\b|\b(?:voice[- ]?over|narrat(?:ion|or)|ai voice|the voice)\b[^.!?\n]{0,25}\b(?:bad|terrible|awful|weird|robotic|annoying|cringe|sucks|is off|not good|horrible|trash|doing (?:very )?bad)\b`, 'i'), patch: { voiceover: 'off' }, why: 'no voiceover' },
  { re: /\b(?:add|with|use|want|need|include|put)\b[^.!?\n]{0,15}\b(?:a |an )?(?:voice[- ]?over|narrat(?:ion|or)|ai voice)\b|\bnarrate (?:it|this|the)\b/i, patch: { voiceover: 'on' }, why: 'you asked for a voiceover', unless: /\b(?:no|without|remove|don'?t)\b[^.!?\n]{0,20}\b(?:voice[- ]?over|narrat)/i },
  { re: new RegExp(String.raw`\b${STRONG_NEG}\b[^.!?\n]{0,20}?\b(?:sound effects?|sfx|whoosh(?:es)?|swoosh(?:es)?|pops?|dings?|random sounds?|weird sounds?|those sounds?)\b|\b(?:random|weird|annoying|cheesy|stupid|extra) (?:sound|noise)s?\b`, 'i'), patch: { sfx: 'off' }, why: 'no sound effects' },
  { re: new RegExp(String.raw`\b${STRONG_NEG}\b[^.!?\n]{0,15}?\b(?:captions?|subtitles?|subs)\b`, 'i'), patch: { captions: 'off' }, why: 'no captions' },
  {
    re: new RegExp(String.raw`\b${STRONG_NEG}\b[^.!?\n]{0,12}?\b(?:the |any |that |those |all )?(?:written |on[- ]?screen |stupid |extra |random |big )?(?:text|titles?|writing|headlines?|words on (?:the )?screen)\b|\b(?:stupid|dumb|weird|random|cringe|annoying|ugly) (?:written )?(?:text|titles?|writing)\b|\bwritten text\b`, 'i'),
    patch: { overlays: 'off' },
    why: 'no on-screen text',
    unless: /\b(?:add|put|write|with|want|include)\b[^.!?\n]{0,15}\b(?:text|title|hook)\b(?![^.!?\n]{0,10}\b(?:off|gone)\b)/i,
  },
  { re: /\b(?:add|put|write|include|want|need)\b[^.!?\n]{0,20}\b(?:a |some |the )?(?:text|title|hook|headline)s?\b/i, patch: { overlays: 'on' }, why: 'you asked for text', unless: new RegExp(String.raw`\b${STRONG_NEG}\b[^.!?\n]{0,12}?\b(?:text|titles?)\b`, 'i') },
];

export function settingsFromText(texts) {
  const patch = {};
  const reasons = {};
  for (const raw of [].concat(texts).filter(Boolean)) {
    const t = String(raw).replace(/[’`]/g, "'");
    for (const r of SETTING_RULES) {
      if (!r.re.test(t) || r.unless?.test(t)) continue;
      // "no music" in the same text wins over "music" mentioned elsewhere in it.
      if (r.patch.music === 'auto' && SETTING_RULES[0].re.test(t) && !SETTING_RULES[0].unless.test(t) && !/\b(?:add|bring back|want|need|put)\b[^.!?\n]{0,30}\b(?:music|song|track)\b/i.test(t)) continue;
      for (const [k, v] of Object.entries(r.patch)) {
        patch[k] = v;
        reasons[k] = r.why;
      }
    }
  }
  return { patch, reasons };
}

/** Does the request ask for narration at all? ("auto" voiceover only narrates when it does.) */
export const asksForVoiceover = (text) => /\b(?:voice[- ]?over|narrat(?:e|ion|or|ing)|ai voice|voice it|someone talking over|tell the story with a voice)\b/i.test(String(text || ''))
  && !/\b(?:no|without|remove|don'?t)\b[^.!?\n]{0,20}\b(?:voice[- ]?over|narrat)/i.test(String(text || ''));

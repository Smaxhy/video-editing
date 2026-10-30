import fs from 'node:fs/promises';
import path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { run, tail, round, clamp, PipelineError } from './util.js';
import { AUTO_PASSES, normalizeAuto } from './directives.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000);

export const TRANSITIONS = [
  'cut', 'crossfade', 'fadeblack', 'slide-left', 'slide-up', 'zoom', 'wipe',
  'zoom-through', 'whip', 'spin', 'light-leak', 'punch', 'flash', 'glitch',
];
/** Transitions that keep a hard cut in time (no overlap): the effect plays on the incoming shot. */
export const CUT_LIKE = new Set(['cut', 'fadeblack', 'punch', 'flash', 'glitch']);
export const SCENE_EFFECTS = ['none', 'kenburns', 'punch-in', 'shake'];
export const INTENSITIES = ['clean', 'creator', 'max'];
export const OVERLAY_TYPES = ['hook', 'title', 'lower-third', 'text', 'caption', 'cta'];
export const POSITIONS = ['top', 'center', 'bottom'];
export const GOALS = ['social', 'ad', 'both'];
export const LENGTHS = ['15', '30', '60', 'full'];

const GOAL_GUIDE = {
  social: `ORGANIC SOCIAL (TikTok / Reels / Shorts) — it must feel made by a person, not a template:
- The first 1.5 seconds decide everything: open on the most surprising, emotional or useful moment — not on "hi everyone". Pull a strong moment forward if needed.
- One short "hook" overlay (2-6 words) over the opening ~2 seconds that teases the payoff. Keep other on-screen text rare and purposeful — not a title on every shot.
- Keep it moving but human: cut out dead air and retakes, yet keep the natural rhythm of speech and the odd real reaction or breath. Vary shot lengths (some 1 s, some 3-4 s) — never a mechanical every-N-seconds pattern.
- Transitions and effects: follow the "Edit intensity" section below.
- Let real sound live: natural sounds (a saw starting, laughter, wind) are part of the story.
- End on a payoff or a loop-able line. No slow outros.`,
  ad: `ADVERTISEMENT (paid social / pre-roll):
- Structure: Hook (0-3s) → Problem or desire → Product/solution & proof → Call to action.
- Add a "hook" overlay in the first ~2.5s. Keep every on-screen claim short and concrete.
- Finish with a "cta" overlay covering the final 2-3 seconds (main text = the action, subtext = brand/offer).
- Tight pacing, no dead air, clean audio fades. Every second must earn its place.`,
};
GOAL_GUIDE.both = `${GOAL_GUIDE.social}\n\n${GOAL_GUIDE.ad}\nBalance both: organic-feeling content that still ends with a clear "cta" overlay.`;

const PLAN_SCHEMA = `{
  "title": "short name for the edit",
  "checklist": [
    { "request": "each distinct instruction from the user's prompt, quoted or paraphrased", "done": "exactly how you fulfilled it, or why it was impossible" }
  ],
  "versions": [
    {
      "id": "30",                 // MUST match the requested version ids
      "summary": "1-2 sentences: what this cut contains",
      "scenes": [
        {
          "clip": "clip1",        // clip id from the catalog
          "start": 12.4,          // IN point, seconds into the SOURCE clip
          "end": 18.9,            // OUT point, seconds into the SOURCE clip (> start)
          "transition": "cut",    // how this scene ENTERS: ${TRANSITIONS.join(' | ')}
          "transitionDuration": 0.4,
          "speed": 1,             // 0.25-4
          "volume": 1,            // 0-2, 0 mutes this scene's original audio
          "effect": "none",       // ${SCENE_EFFECTS.join(' | ')}
          "peak": false,          // true on the ONE scene where the video's biggest moment starts (only with a music section)
          "note": "why this scene is here"
        }
      ],
      "overlays": [
        {
          "type": "hook",         // ${OVERLAY_TYPES.join(' | ')}
          "text": "Main text",
          "subtext": "optional second line",
          "start": 0,             // OUTPUT timeline seconds
          "end": 2.5,
          "position": "top"       // ${POSITIONS.join(' | ')}
        }
      ],
      "audio": { "fadeIn": 0, "fadeOut": 0.4 },
      "narration": [              // ONLY when a Voiceover section is given below; else []
        { "text": "One spoken sentence.", "start": 0.3 }   // start = OUTPUT seconds
      ]
    }
  ],
  "auto": {                                // which automatic passes may change your plan afterwards (see "After your plan")
    "beatEdit": true, "beatSnap": true, "styling": true, "slowmo": true, "finish": true
  },
  "music": { "track": "m1", "start": 0 },  // ONLY when a music section is given below; omit otherwise
  "emphasis": [                            // ONLY when captions are on: words the captions should make pop
    { "word": "timber", "emoji": "🌲" }    // a single spoken word; emoji optional (null) — at most 1 in 3 gets one
  ],
  "sound": {                               // the trending-style sound to add in TikTok/Instagram when posting
    "vibe": "the video's vibe in 2-4 words, e.g. calm satisfying craft",
    "energy": "low | medium | high",
    "search": ["what to type in the app's sound search", "an alternative"],
    "style": "the music style that carries that vibe, e.g. soft acoustic lo-fi",
    "bpm": 90,
    "part": "which part of the sound to use (e.g. start on the drop)",
    "why": "one line: why it fits the vibe",
    "prompt": "a vivid prompt for an AI music generator: genre, instruments, mood, tempo — e.g. warm lo-fi hip hop beat, soft rhodes chords, vinyl crackle, 85 bpm",
    "options": [{ "search": "…", "style": "…" }]
  }
}`;

/** What separates a top-tier short-form edit from a template one. */
/** How much styling the edit gets. Exported for tests. */
export const INTENSITY_GUIDE = {
  clean: `Clean — a documentary / talking-head feel: straight cuts; a transition only where place or time changes ("crossfade", "fadeblack", "light-leak"). Effects ("kenburns", "punch-in") sparingly.`,
  creator: `Creator — edit like a top creator; styled but never random:
- 3-6 styled transitions per 30 s, placed where the energy shifts or on a beat between B-roll / montage shots (never inside a sentence): "punch" (zoom-in cut, most versatile), "whip" (fast pan between related shots), "zoom-through" (into a new place), "flash" (on a drop or a reveal), "glitch" (tech / gaming / hype), "spin" (playful, rare), "light-leak" (warm, nostalgic, lifestyle). Match them to the vibe — calm videos get light-leak / crossfade / punch, hype videos get punch / whip / flash / glitch.
- Talking: straight cuts or "punch" between sentences; "punch-in" effect on the key line.
- "shake" effect on 1-2 impact moments (a hit, a slam, a reveal, the drop).
- Slow motion ("speed" 0.5) on the peak moment of motion footage.`,
  max: `Max — high-energy edit (sport, gaming, hype, transformations):
- A styled transition or punch on MOST B-roll / montage cuts, landing on the beat: rotate "punch", "whip", "zoom-through", "flash" (on the drop), "glitch". Never the same one three times in a row.
- "shake" on every impact; slow motion ("speed" 0.4-0.6) into the peak, fast ("speed" 1.5-2.5) through filler.
- Short shots (0.4-1.5 s) in the build-up; hold the payoff.`,
};

const CRAFT = `
## Editing craft (top-tier editors do this; the user's words and the creator style still win)
- Hook (first 1.5 s): picture, text and sound hit together. Open mid-action or on a teaser of the result — never on setup. The hook overlay says what the picture can't.
- Shape: hook → quick context → escalation (every scene raises the stakes: closer, faster, more detail) → PEAK (the best shot) → payoff → an ending that loops back into the opening or lands the strongest image. No flat middle.
- Pattern interrupt every 2-4 s: a new angle, shot size (wide → close → detail), direction of motion, a text beat or a sound. Never two near-identical shots back to back.
- Cut on action: leave a shot while it still moves and enter the next one already moving; drop the first frames where a camera is still settling and the tail after an action has finished.
- Speed with purpose: "speed" 0.5-0.7 on the 1-3 s peak moment of motion footage without speech (slow motion makes it land; set that scene's "volume" to 0-0.3); 1.5-2.5 for slow process parts of a montage (never on speech). Most scenes stay at 1.
- Rhythm: shots get shorter as energy builds; hold one longer shot at the payoff so it breathes.
- Talking: keep every word that matters, cut breath gaps, repeats and retakes; keep real reactions (a laugh, a look) that add personality.
- Organic social ends on a cut, an action or a loopable line — no slow fade-out.
`;

/** Settings a revision may change (e.g. "no green filter" → polish off), with their allowed values. */
export const REVISABLE = {
  polish: [true, false],
  look: ['natural', 'warm', 'cool', 'moody', 'vibrant', 'film'],
  captions: ['bold', 'pop', 'clean', 'off'],
  captionPos: ['bottom', 'middle'],
  motion: ['off', 'subtle', 'punchy'],
  sfx: ['off', 'subtle', 'full'],
  music: ['off', 'auto'],
  musicLevel: ['low', 'medium', 'high'],
  tighten: ['off', 'natural', 'tight'],
  voiceover: ['off', 'auto', 'on'],
  beatSync: [true, false],
  framing: ['smart', 'blur', 'crop', 'fit'],
  proAudio: [true, false],
};
const SETTING_HELP = {
  polish: 'automatic colour/exposure correction, stabilisation and sharpening',
  look: 'colour grade on top',
  captions: 'caption style (off removes them)',
  captionPos: 'where captions sit',
  motion: 'automatic zooms / punch-ins',
  sfx: 'whoosh/pop sound effects',
  music: '"off" removes the background music, "auto" puts the creator\'s music back under the video',
  musicLevel: 'music volume',
  tighten: 'how hard pauses are cut',
  voiceover: 'AI narrator',
  beatSync: 'cuts snapped to the music beat',
  framing: 'how wide shots fit the vertical frame',
  proAudio: 'voice clean-up / levelling',
};

function revisionSection({ remarks, previous, current, applied = [], auto = null, earlier = [] }) {
  const keys = Object.entries(REVISABLE)
    .map(([k, v]) => `- "${k}": ${v.map((x) => JSON.stringify(x)).join(' | ')} — ${SETTING_HELP[k]}${current[k] !== undefined ? ` (now ${JSON.stringify(current[k])})` : ''}`)
    .join('\n');
  return `
## REVISION — the user watched the last render and wants changes
Their remarks (highest authority — above the original request):
"""
${remarks}
"""
${earlier.length ? `Earlier fixes the user asked for — they STILL apply, keep them done:
${earlier.map((r, i) => `${i + 1}. """${r}"""`).join('\n')}

` : ''}Start from the previous edit below and change ONLY what the remarks ask for (plus what those changes require). Keep every other scene, cut point, text, timing and the music exactly as they were — unless the remarks ask for a different sound/song: then use the track given in the Music section and re-time the cut to it (B-roll cuts on its beat, the peak on its drop). Record each remark and what you changed in "checklist".
If a remark is about the look, sound or captions rather than the cut (e.g. "the colours look green", "no music", "captions too big"), change the render settings by adding "settings" to your response with ONLY the keys you change:
${keys}

${applied?.length ? `After that plan, ClipForge's automatic passes changed the video the user watched:
${applied.map((a) => `- ${a}`).join('\n')}
If a remark is about something those passes did (re-ordered or re-cut shots, slow motion, extra transitions, punch-ins, shakes, flashes, word-by-word text, grain), switch that pass off in "auto" — your plan alone does not contain those changes.
` : ''}Automatic passes last time: ${JSON.stringify(auto || {})} — keep these values unless the remarks call for a change.

Previous edit (JSON):
${previous}
`;
}

/** Keep only allowed setting changes from a revision response. Exported for tests. */
export function normalizeSettingChanges(raw) {
  const out = {};
  for (const [k, allowed] of Object.entries(REVISABLE)) {
    if (raw && Object.prototype.hasOwnProperty.call(raw, k) && allowed.includes(raw[k])) out[k] = raw[k];
  }
  return out;
}

/** "Sound for posting" section: the creator attaches a trending sound in TikTok/Instagram themselves. */
/** How to choose the sound: from the video's vibe, never from what is literally on screen. */
const SOUND_RULES = `How to choose it — match the VIBE of this edit, not the objects in it:
- First decide the video's vibe: its mood (e.g. calm, satisfying, epic, funny, motivational, nostalgic, tense, cosy) and energy (low / medium / high), from the brief, the footage, the pacing you planned and the creator's style.
- Then pick music that carries that feeling, the way a top creator in this niche would — e.g. calm & satisfying → soft lo-fi or acoustic; epic / powerful → cinematic build or slowed phonk; hype → fast drill / sped-up pop; funny → quirky or meme sounds; emotional → piano or slowed vocals.
- "search" = what to type in the TikTok/Instagram sound search to find trending sounds of that kind (genre + mood words, or a well-known trending sound name if one clearly fits). Never literal sound effects of the footage ("chainsaw sound", "wood chopping") unless the vibe is ASMR / satisfying-sounds.
- "options": 2-3 alternatives at different energies (a safe popular pick, a more niche one).
- "bpm" must suit the vibe (calm 70-95, medium 95-125, hype 125-160).`;

function soundSection(options) {
  if (options.trendingSound) {
    return `
## Trending sound (added in the app when posting)
NO background music is mixed into this video — the creator adds a trending sound inside TikTok/Instagram when posting (that is where it is licensed). So:
- Keep the clips' natural sound (scene "volume" ~0.6-1) unless it is ugly; talking stays at full volume.
- Pace it like a video made for a trending track: pick a tempo for the vibe ("sound.bpm", usually 90-150) and cut B-roll/montage on every 2nd or 4th beat of it (ClipForge snaps the cuts to that grid). Put the biggest visual moment where a drop would land (~1/3 in).
- Fill "sound" with what to search for in the app's sound picker.
${SOUND_RULES}
`;
  }
  const composed = options.aiMusic && !options.music
    ? `
The user has no music in their library: ClipForge composes the background music for this video with a local AI model from "sound.prompt" — make it vivid and specific (genre, 2-3 instruments, mood, bpm). Pace the cut for that tempo; music plays under the whole video.`
    : '';
  return `
## Sound idea for posting
Also fill "sound": the kind of trending sound that would suit this video if the creator swaps or adds one in the app.${composed}
${SOUND_RULES}
`;
}

/** Validate the planner's sound suggestion. Exported for tests. */
export function normalizeSound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const search = (Array.isArray(raw.search) ? raw.search : String(raw.search || '').split(/[;,|]/)).map((s) => t(s, 60)).filter(Boolean).slice(0, 4);
  const bpm = Number(raw.bpm);
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((o) => ({ search: t(o?.search, 60), style: t(o?.style, 100) }))
    .filter((o) => o.search)
    .slice(0, 3);
  const out = {
    vibe: t(raw.vibe, 60),
    energy: ['low', 'medium', 'high'].includes(raw.energy) ? raw.energy : null,
    search,
    style: t(raw.style, 120),
    part: t(raw.part, 120),
    why: t(raw.why, 200),
    prompt: t(raw.prompt, 200),
    bpm: Number.isFinite(bpm) ? Math.round(clamp(bpm, 60, 180)) : null,
    options,
  };
  return out.search.length || out.style ? out : null;
}

/** A steady beat grid (seconds) for cutting to a sound that isn't in the library. */
export function beatGrid(bpm, total) {
  const step = 60 / clamp(bpm || 120, 60, 180);
  const beats = [];
  for (let t = step; t < total; t += step) beats.push(round(t, 3));
  return { beats, downbeats: beats.filter((_, i) => i % 4 === 3) };
}

function versionLine(id) {
  if (id === 'full') return `- "full": the complete edit — length is whatever the user's request implies (no artificial limit).`;
  return `- "${id}": at most ${id} seconds of output (aim for ${Math.round(Number(id) * 0.9)}-${id}s). If the usable footage is shorter, use what there is.`;
}

/**
 * Build the prompt sent to `claude -p`.
 * clips: [{ id, name, duration, width, height, hasAudio, transcript }]
 * options: { goal, versions: ['15','30',...], formats: [{key,label,width,height}], captions, cta, brand }
 */
export function buildPrompt({ clips, userPrompt, options }) {
  const catalog = clips
    .map((c) => {
      const t = c.transcript;
      const lines = t?.segments?.length
        ? t.segments.map((s) => `    [${fmt(s.start)} - ${fmt(s.end)}] ${s.text}`).join('\n')
        : `    (no speech detected${t?.note ? ` — ${t.note}` : ''})`;
      const a = c.analysis || {};
      const list = (arr, fmtItem, max = 40) =>
        arr.length > max ? `${arr.slice(0, max).map(fmtItem).join(', ')} … (+${arr.length - max} more)` : arr.map(fmtItem).join(', ');
      return [
        `### ${c.id}`,
        `- file: ${c.name}`,
        `- duration: ${round(c.duration)}s · ${c.width}x${c.height} · audio: ${c.hasAudio ? 'yes' : 'no'}${t?.language ? ` · language: ${t.language}` : ''}`,
        c.visual?.summary ? `- on screen (AI looked at the frames): ${c.visual.summary}${c.visual.shot && c.visual.shot !== 'other' ? ` [${c.visual.shot}]` : ''}` : null,
        c.visual?.tags?.length ? `- tags: ${c.visual.tags.join(', ')}` : null,
        c.visual?.moments?.length ? `- best moments (SOURCE seconds): ${c.visual.moments.map((m) => `${fmt(m.start)}-${fmt(m.end)} ${m.what}`).join('; ')}` : null,
        c.visual?.quality ? `- quality: ${c.visual.quality}` : null,
        c.sheet ? `- contact sheet: ${c.sheet.file} — tiles left→right, top→bottom at ${c.sheet.times.map(fmt).join(', ')}s` : null,
        a.silences ? `- silent ranges (no sound, SOURCE seconds): ${a.silences.length ? list(a.silences, ([x, y]) => `${fmt(x)}-${fmt(y)}`) : 'none'}` : null,
        a.shots ? `- shot changes (SOURCE seconds): ${a.shots.length ? list(a.shots, fmt) : 'none — one continuous shot'}` : null,
        a.faces ? `- on-camera face: ${faceSummary(a.faces, c.duration)}` : null,
        `- transcript (SOURCE seconds):`,
        lines,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const formats = options.formats.map((f) => `${f.label} (${f.width}x${f.height})`).join(', ');
  const brandLines = [
    options.brand ? `- Brand / product name: "${options.brand}" (use verbatim)` : null,
    options.cta ? `- Call to action: "${options.cta}" (use verbatim as the "cta" overlay text)` : null,
  ].filter(Boolean);

  const sheets = clips.some((c) => c.sheet);
  const seeing = sheets
    ? 'You have the clip catalog, Whisper transcripts, AI descriptions of what is on screen, and a contact sheet (a grid of frames) per clip. Use the Read tool to open every contact sheet listed in the catalog before planning, so your cuts match what is actually on screen.'
    : clips.some((c) => c.visual)
      ? 'You cannot watch the footage, but you have the clip catalog, Whisper transcripts and AI descriptions of what is on screen.'
      : 'You cannot see the footage; you have the clip catalog and Whisper transcripts below.';
  const vo = options.voiceover;
  const voiceoverSection = !vo || vo.mode === 'off' ? '' : `
## Voiceover
${vo.mode === 'on'
    ? 'Write a spoken voiceover ("narration") for every version.'
    : 'If the footage has little or no speech and a narrator would make the video better (story, how-to, documentary, motivational, explainer), write a spoken voiceover ("narration") for every version. If people already talk on camera, or the vibe is a pure music montage, leave "narration" empty.'}
- A natural AI voice (${vo.voiceLabel}) reads each line. Write how the creator would talk to a friend, not how people write: short sentences (max ~14 words), contractions, concrete words, no clichés ("in today's video", "let's dive in", "embark", "journey"). Never describe what the viewer can already see — add what they can't (the why, the feeling, the twist). The first line is the hook and starts at ~0.3 s.
- If the user said what the voiceover should say, use their words. Leave room to breathe: about 2.3 words per second, total speech at most ~55% of the version's length so the music is heard, lines in order and never overlapping.
- Never narrate over moments where someone on camera is talking. Under narration set those scenes' "volume" to 0.15-0.35 so the natural sound stays as texture.
- Narration is turned into captions automatically — do not add text overlays repeating it.
`;
  const music = options.music;
  const heard = music?.tracks?.some((t) => t.sound);
  const musicSection = !music || music.mode === 'off' ? '' : `
## Music
${music.mode === 'fixed'
    ? `The user chose track ${music.fixed} (listed below). Set "music": { "track": "${music.fixed}", "start": <seconds into the track where the best part begins> }.`
    : `Pick ONE song from the user's music library below — the one whose vibe best matches this video — and set "music": { "track": "<id>", "start": <seconds into the track to begin> }. The user wants THEIR music used: always pick one of these tracks (the closest match if none is perfect), never leave the video without music.`}
${heard ? `ClipForge listened to the tracks: tempo, energy, genre and mood, the drop (where the track lifts hardest), its loud parts and an energy curve.
${music.mode === 'fixed' ? '' : `- Match the VIBE first: the mood of the track must be the mood of the video (calm satisfying craft → calm lo-fi / acoustic / ambient; hype, sport, glow-up, transformation → energetic drill / phonk / trap / EDM; emotional story → sad piano / cinematic; epic reveal → cinematic or slowed phonk; funny → quirky / meme). Then match energy and tempo to the pacing you cut. Never put a sad track on a happy video or a hype track on a calm one. Say which track you chose and why in "checklist".
`}- Cut to the tempo: one beat = 60 / BPM seconds. Make B-roll / montage shots last whole numbers of beats (1, 2 or 4) — ClipForge snaps the cuts onto the beat afterwards.
- Mark the scene where the video's biggest moment starts with "peak": true (one per version). When the track has a drop, ClipForge starts the music so the drop hits exactly that cut. Build toward it: shorter, faster shots before the peak, the best shot on it.
- "start": where the music should begin when it cannot be aligned — usually the start of a loud part, so the video never opens in a quiet intro (unless the vibe is calm).
` : ''}Music plays under the whole video and is automatically lowered while someone speaks. When the music leads (montage, POV, no talking), set scene "volume" to 0.2-0.5 so natural sound stays as texture — unless the user wants the original sound up front.
${music.tracks.map((t) => `- ${t.id}: "${t.name}" · ${round(t.duration)}s${t.tags ? ` · ${t.tags}` : ''}${t.sound ? `\n    heard: ${t.sound}` : ''}`).join('\n')}
`;

  return `You are ClipForge's edit planner — a senior short-form video editor. ${seeing} Produce precise edit decision lists.

## RULE #1 — do exactly what the user asks
The user's request below is the highest authority. Follow every instruction literally: specified text is used word for word, specified order/timing/transitions/clips are respected, anything they say to remove is removed. The style guide further down only fills gaps the user left open; never let it override an explicit instruction. Record every instruction and how you handled it in "checklist".

## After your plan — ClipForge's automatic passes (you decide which may run)
Unless you switch them off in "auto", ClipForge changes your plan after you answer:
${Object.entries(AUTO_PASSES).map(([k, v]) => `- "${k}": ${v}.`).join('\n')}
They make generic requests look great, but they REWRITE what you planned. Set a pass to false whenever it would break something the user asked for — e.g. a set clip order or timing, whole clips, a calm/slow pace, "no slow motion", simple or specific cuts/transitions, "no effects", plain text. When the user gave you no specific instructions about those things, leave them true.

## User's request
"""
${userPrompt}
"""

${options.revision ? revisionSection(options.revision) : ''}
## Deliverables
Produce one version per id below. Each version is a complete, standalone edit of the same story (shorter versions keep only the strongest moments):
${options.versions.map(versionLine).join('\n')}

Every version will be rendered in these frame formats: ${formats}. Keep overlay text short so it fits a narrow 9:16 frame.
Captions: ${options.captions === 'off' ? 'OFF' : `burned in automatically from the transcript (style "${options.captions}") — do NOT add "caption" overlays repeating spoken words. Fill "emphasis" with the 4-12 spoken words that carry the meaning (numbers, key nouns, payoff words, strong verbs); they are coloured and popped in the captions. Add a fitting emoji to the most visual ones (max one emoji per ~3 seconds; skip emoji for serious topics)`}.
${brandLines.length ? `${brandLines.join('\n')}\n` : ''}
## Style guide (only where the user is silent)
${options.style ? `Match the creator's own style — copied from reference videos they love. This beats the generic advice below.
${options.style}

Generic advice (only where the style above says nothing):
` : ''}${GOAL_GUIDE[options.goal]}
${CRAFT}${options.clipAudio === 'off' ? `
## Music-only edit
The clips' own sound is MUTED — only the music plays (plus sound effects). This is a music edit: choose shots purely for how they look and move, cut them to the music's beat and energy (shorter shots in the build, the best shot on the drop), and never rely on speech; set every scene "volume" to 0.
` : options.clipAudio === 'low' ? `
## Clip sound low
The clips' own sound plays quietly under the music (talking stays clear). Let the music carry the edit.
` : ''}
## Edit intensity
${INTENSITY_GUIDE[options.intensity] || INTENSITY_GUIDE.creator}
Transition reference: "cut"/"punch"/"flash"/"glitch" keep the cut on time; "crossfade", "light-leak", "zoom-through", "whip", "spin" blend the shots over "transitionDuration" (whip 0.2-0.3, zoom-through/spin 0.3-0.4, light-leak 0.5-0.8).
${musicSection}${voiceoverSection}${soundSection(options)}
## Clip catalog
${catalog}

## Editing rules
- Scenes play in array order. Each scene is a range [start, end) of ONE clip in SOURCE seconds; ranges must lie within the clip's duration.
- Cut on sentence/phrase boundaries from the transcript; never mid-word. Pad ~0.1s before speech and ~0.2s after.
- Remove filler, dead air, false starts and retakes by splitting into several scenes that skip them (unless the user wants them kept). When "silent ranges" are listed, they are measured from the audio — use them to place cuts precisely.
- When "shot changes" are listed, prefer cutting on them for B-roll and montage footage, and avoid starting a scene a few frames before a shot change.
- Output length = sum of (end - start) / speed, minus overlap of non-cut transitions. Respect each version's length limit.
- Transitions: "cut" for talking content; others sparingly between distinct moments; transitionDuration 0.2-0.8s.
- Overlay times are OUTPUT timeline seconds and must fit inside that version's length. Overlays must not overlap each other in time unless they sit in different positions.
- Footage with little or no speech (POV, B-roll, montage): build the story from the visuals — use the "best moments", cut on shot changes, keep scenes 1-4s. If the user asks for subtitles/text or a theme (e.g. "the art of tree cutting"), write short on-screen lines as "title"/"text" overlays (2-7 words, 2-3s each, one at a time) that narrate the video — these are its subtitles.
- "hook" = big punchy text at the top in the opening seconds. "title" = centered title card. "lower-third" = name/role or place label (3-5s). "text" = short on-screen point. "cta" = end card with the call to action (last 2-3s).

## Final check — before you answer
Re-read the user's request${options.revision ? ' and every remark' : ''} below and make sure the plan does ALL of it. Every instruction gets a "checklist" entry saying exactly how it is done; if one is impossible with this footage, say why in its "done" instead of quietly ignoring it.${musicSection ? ' A Music section is given: "music" MUST name one of its tracks.' : ''}
"""
${String(userPrompt).slice(0, 6000)}${options.revision ? `
--- fixes asked after watching ---
${[...(options.revision.earlier || []), options.revision.remarks].map((r) => `- ${r}`).join('\n').slice(0, 6000)}` : ''}
"""

## Response format
Respond with ONE JSON object and nothing else — no prose, no markdown fences. Escape double quotes inside text (\\"). Keep every "note" under 12 words and every checklist "done" under 30 words so the answer stays short. Shape (comments are explanatory, omit them):
${PLAN_SCHEMA}
`;
}

/**
 * Ask Claude Code (pipe mode, your subscription — no API key) for every version's edit plan
 * in a single call, then validate. Retries once with the validation error.
 */
export const PLANNER_MODELS = ['sonnet', 'haiku', 'opus'];

export async function generateEditPlans({ clips, userPrompt, options, cwd, onStatus, signal }) {
  const prompt = buildPrompt({ clips, userPrompt, options });
  let lastError;
  let raw = '';

  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const input =
      attempt === 1
        ? prompt
        : `${prompt}\n\n## Your previous answer was rejected\nReason: ${lastError.message}\nReply again with the complete, valid JSON object only: escape every double quote inside text as \\", no comments, keep every "note" under 12 words and every checklist "done" under 30 words.`;

    onStatus?.(attempt === 1 ? 'Claude is planning the edit…' : `Plan was invalid — asking Claude to fix it (try ${attempt}/${ATTEMPTS})…`);
    raw = await callClaude(input, { cwd, signal, model: options.model, tools: clips.some((c) => c.sheet) ? 'Read' : '' });

    try {
      const json = extractJson(raw);
      // A cut-off answer is only used on the last try (its final scenes may be missing).
      if (wasTruncated(json) && attempt < ATTEMPTS) throw new Error('your answer was cut off before the end — it was too long');
      const result = normalizeResponse(json, clips, options);
      if (wasTruncated(json)) result.warnings.push('Claude\'s plan was cut off — the last part of the edit may be shorter than planned.');
      return { ...result, prompt, raw };
    } catch (err) {
      lastError = err;
      // Keep the unreadable answer next to the prompt, for troubleshooting.
      if (cwd) await fs.writeFile(path.join(cwd, `claude-response-invalid-${attempt}.txt`), raw).catch(() => {});
    }
  }
  throw new PipelineError('Claude did not return a usable edit plan.', {
    detail: `${lastError.message}\n\nRaw response:\n${raw.slice(0, 2000)}`,
    hint: 'Try rephrasing the prompt more concretely (e.g. which parts to keep, target length).',
  });
}

/**
 * One `claude -p` call. tools '' = pure text; tools 'Read' lets Claude open the frame-grid
 * images in cwd (and nothing else — no shell, no writes). --no-session-persistence: don't clutter history.
 */
export async function callClaude(input, { cwd, signal, tools = '', model }) {
  const args = ['-p', '--output-format', 'text', '--tools', tools, '--no-session-persistence'];
  if (tools) args.push('--allowedTools', tools);
  // Sonnet by default: plans edits well while using far less of your plan than Opus.
  args.push('--model', process.env.CLAUDE_MODEL || model || 'sonnet');

  let res;
  try {
    res = await run(CLAUDE_BIN, args, {
      cwd,
      input,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      signal,
      // Claude Code prefers an API key over the subscription login when one is set, which would
      // bill Console credits. Strip it so planning always runs on the subscription.
      // CLIPFORGE_ALLOW_API_KEY=1 opts back in.
      unsetEnv: process.env.CLIPFORGE_ALLOW_API_KEY === '1' ? [] : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PipelineError('Claude Code CLI (`claude`) is not installed.', {
        hint: 'Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in with your subscription.',
      });
    }
    throw err;
  }
  const out = (res.stdout || '').trim();
  if (res.timedOut) {
    throw new PipelineError('Claude took too long to answer.', {
      hint: `Timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s. Set CLAUDE_TIMEOUT_MS to allow longer.`,
    });
  }
  if (res.code !== 0 || !out) {
    const detail = tail(res.stderr || out);
    let hint;
    if (/log ?in|auth|credential|401|unauthori[sz]ed|API key/i.test(detail)) {
      hint = 'Claude Code is not logged in. Run `claude` in a terminal and complete login, then try again.';
    } else if (/rate limit|usage limit|429|overloaded/i.test(detail)) {
      hint = 'You hit a Claude usage or rate limit — wait for it to reset and retry (your clips and transcripts are kept).';
    }
    throw new PipelineError('The `claude -p` call failed.', { detail, hint });
  }
  return out;
}

/** Answers that were cut off before the end (repaired, but possibly missing their last parts). */
const TRUNCATED = new WeakSet();
export const wasTruncated = (v) => TRUNCATED.has(v);

/**
 * Index of the brace that closes the object opened at `start` (strings skipped), or -1 when the text
 * ends first — i.e. the answer was cut off. A stray unescaped quote can fool it, which only means we
 * treat the answer as cut off and ask again.
 */
function closingIndex(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Where strict JSON parsing fails, with a short excerpt — tells Claude exactly what to fix. */
function parseProblem(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const m = String(err.message).match(/position (\d+)/);
    const pos = m ? Number(m[1]) : null;
    return pos == null ? err.message : `${err.message} — near: …${text.slice(Math.max(0, pos - 80), pos + 40).replace(/\s+/g, ' ')}…`;
  }
}

/** Pull a JSON object out of a model response (tolerates fences, stray prose and common JSON slips). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    // Second variant strips trailing // comments in case the model echoed the schema's style.
    const noComments = c.replace(/\/\/[^\n"]*$/gm, '');
    for (const variant of [c, noComments]) {
      try {
        const v = JSON.parse(variant);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch {
        /* try next */
      }
    }
  }
  // Repair: unescaped quotes inside text, trailing commas, curly quotes, missing commas — and
  // answers cut off before the end (brackets get closed; flagged so the caller can decide).
  if (first !== -1) {
    const end = closingIndex(text, first);
    const complete = end !== -1;
    try {
      const v = JSON.parse(jsonrepair(complete ? text.slice(first, end + 1) : text.slice(first)));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!complete) TRUNCATED.add(v);
        return v;
      }
    } catch {
      /* fall through */
    }
  }
  const problem = first !== -1 ? parseProblem(text.slice(first, last > first ? last + 1 : undefined)) : 'no JSON object in the answer';
  throw new Error(`response was not valid JSON (${problem})`);
}


/**
 * Validate the multi-version response. Each requested version id must be present
 * (a plain single-plan answer is accepted as the only version).
 */
export function normalizeResponse(raw, clips, options) {
  const warnings = [];
  const list = Array.isArray(raw.versions) ? raw.versions : raw.scenes ? [{ ...raw, id: options.versions[0] }] : [];
  const versions = [];

  for (const id of options.versions) {
    const v = list.find((x) => String(x?.id ?? '').replace(/s$/, '') === id) ?? (options.versions.length === 1 ? list[0] : null);
    if (!v) throw new Error(`version "${id}" is missing from "versions"`);
    let result;
    try {
      result = normalizePlan(v, clips);
    } catch (err) {
      throw new Error(`version "${id}": ${err.message}`);
    }
    const length = planLength(result.plan);
    if (id !== 'full' && length > Number(id) * 1.25) {
      warnings.push(`${id}s version came out ${length.toFixed(1)}s long.`);
    }
    warnings.push(...result.warnings.map((w) => `${id === 'full' ? 'Full' : `${id}s`}: ${w}`));
    versions.push({ id, plan: { ...result.plan, title: String(raw.title || v.title || 'ClipForge edit').slice(0, 120) } });
  }

  const checklist = (Array.isArray(raw.checklist) ? raw.checklist : [])
    .filter((c) => c && (c.request || c.done))
    .map((c) => ({ request: String(c.request || ''), done: String(c.done || '') }));

  let music = null;
  const m = options.music;
  if (m && m.mode !== 'off' && m.tracks.length) {
    const want = m.mode === 'fixed' ? m.fixed : String(raw.music?.track || '').trim();
    const track = m.tracks.find((t) => t.id === want) || (m.mode === 'fixed' ? m.tracks.find((t) => t.id === m.fixed) : null);
    if (track) {
      const start = Number(raw.music?.start);
      music = { track: track.id, start: Number.isFinite(start) ? clamp(start, 0, Math.max(0, track.duration - 5)) : 0 };
    } else {
      // The user's own music always wins: fall back to the track whose energy fits the planned vibe.
      const energy = raw.sound?.energy;
      const pick = m.tracks.find((t) => energy && new RegExp(`${energy} energy`).test(t.sound || '')) || m.tracks[0];
      music = { track: pick.id, start: 0 };
      warnings.push(`Claude did not name a music track — used "${pick.name}" from your library.`);
    }
  }

  const emphasis = (Array.isArray(raw.emphasis) ? raw.emphasis : [])
    .map((e) => ({
      word: String(e?.word ?? e ?? '').trim().split(/\s+/)[0].slice(0, 30),
      // Emoji only: no letters/digits, a few code points at most.
      emoji: typeof e?.emoji === 'string' && /^[^\p{L}\p{N}\s]{1,8}$/u.test(e.emoji.trim()) ? e.emoji.trim() : null,
    }))
    .filter((e) => e.word)
    .slice(0, 20);

  const settingsChanges = options.revision ? normalizeSettingChanges(raw.settings) : {};

  const auto = normalizeAuto(raw.auto, options.revision?.auto || null);
  return { title: String(raw.title || 'ClipForge edit').slice(0, 120), checklist, versions, warnings, music, emphasis, settingsChanges, sound: normalizeSound(raw.sound), auto };
}

/** Output length of a normalized plan (sum of scene lengths minus transition overlaps). */
export function planLength(plan) {
  let total = 0;
  plan.scenes.forEach((s, i) => {
    const d = (s.end - s.start) / s.speed;
    const overlap = i > 0 && !CUT_LIKE.has(s.transition) ? Math.min(s.transitionDuration, d / 2) : 0;
    total += d - overlap;
  });
  return total;
}

/**
 * Validate and clamp one plan against the real clips. Fixes what it can (out-of-range times,
 * unknown enum values) and reports each fix as a warning; throws only when unusable.
 */
export function normalizePlan(raw, clips) {
  const warnings = [];
  const byId = new Map(clips.map((c) => [c.id, c]));
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    throw new Error('"scenes" must be a non-empty array');
  }

  const scenes = [];
  raw.scenes.forEach((s, i) => {
    const clip = byId.get(String(s?.clip ?? '').trim());
    if (!clip) {
      warnings.push(`scene ${i + 1} used unknown clip "${s?.clip}" — dropped.`);
      return;
    }
    if (!Number.isFinite(Number(s.end)) || !Number.isFinite(Number(s.start))) {
      warnings.push(`scene ${i + 1} had no start/end — dropped.`);
      return;
    }
    const start = clamp(num(s.start, 0), 0, clip.duration);
    const end = clamp(num(s.end, clip.duration), 0, clip.duration);
    if (start !== num(s.start, 0) || Math.abs(end - num(s.end, clip.duration)) > 0.05) {
      warnings.push(`scene ${i + 1} times clamped to the length of ${clip.id}.`);
    }
    if (end - start < 0.1) {
      warnings.push(`scene ${i + 1} had an empty range — dropped.`);
      return;
    }
    const transition = TRANSITIONS.includes(s.transition) ? s.transition : 'cut';
    scenes.push({
      clip: clip.id,
      start: round(start, 3),
      end: round(end, 3),
      transition,
      transitionDuration: transition === 'cut' ? 0 : clamp(num(s.transitionDuration, 0.4), 0.1, 2),
      speed: clamp(num(s.speed, 1), 0.25, 4),
      volume: clamp(num(s.volume, 1), 0, 2),
      effect: SCENE_EFFECTS.includes(s.effect) ? s.effect : 'none',
      ...(s.peak === true && !scenes.some((x) => x.peak) ? { peak: true } : {}),
      note: typeof s.note === 'string' ? s.note : '',
    });
  });

  if (scenes.length === 0) throw new Error('no scene referenced a valid clip/time range');

  // The very first scene has nothing to transition from; only a fade from black makes sense.
  if (!['cut', 'fadeblack', 'punch', 'flash', 'glitch'].includes(scenes[0].transition)) scenes[0].transition = 'fadeblack';

  const overlays = (Array.isArray(raw.overlays) ? raw.overlays : [])
    .map((o) => {
      const text = String(o?.text ?? '').trim();
      if (!text) return null;
      const start = Math.max(0, num(o.start, 0));
      const end = num(o.end, start + 3);
      if (end - start < 0.2) return null;
      const type = OVERLAY_TYPES.includes(o.type) ? o.type : 'text';
      return {
        type,
        text: text.slice(0, 160),
        subtext: o.subtext ? String(o.subtext).slice(0, 160) : '',
        start: round(start, 3),
        end: round(end, 3),
        position: POSITIONS.includes(o.position) ? o.position : defaultPosition(type),
      };
    })
    .filter(Boolean);

  const narration = (Array.isArray(raw.narration) ? raw.narration : [])
    .map((l) => ({ text: String(l?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), start: round(Math.max(0, num(l?.start, 0)), 3) }))
    .filter((l) => l.text)
    .sort((a, b) => a.start - b.start)
    .slice(0, 24);

  return {
    plan: {
      summary: String(raw.summary || ''),
      scenes,
      overlays,
      narration,
      audio: {
        fadeIn: clamp(num(raw.audio?.fadeIn, 0), 0, 5),
        fadeOut: clamp(num(raw.audio?.fadeOut, 0.4), 0, 5),
      },
    },
    warnings,
  };
}

function defaultPosition(type) {
  if (type === 'hook') return 'top';
  if (type === 'title' || type === 'cta') return 'center';
  return 'bottom';
}

/** "visible in 80% of the clip" style summary from sampled face detections (~2 per second). */
function faceSummary(faces, duration) {
  const samples = Math.max(1, Math.round(duration * 2));
  const pct = Math.min(100, Math.round((faces.length / samples) * 100));
  return pct === 0 ? 'none detected (B-roll / screen / scenery)' : `visible in about ${pct}% of the clip`;
}

function fmt(t) {
  return Number(t).toFixed(2);
}

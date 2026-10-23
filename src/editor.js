import { run, tail, round, clamp, PipelineError } from './util.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000);

export const TRANSITIONS = ['cut', 'crossfade', 'fadeblack', 'slide-left', 'slide-up', 'zoom', 'wipe'];
export const SCENE_EFFECTS = ['none', 'kenburns', 'punch-in'];
export const OVERLAY_TYPES = ['hook', 'title', 'lower-third', 'text', 'caption', 'cta'];
export const POSITIONS = ['top', 'center', 'bottom'];
export const GOALS = ['social', 'ad', 'both'];
export const LENGTHS = ['15', '30', '60', 'full'];

const GOAL_GUIDE = {
  social: `ORGANIC SOCIAL (TikTok / Reels / Shorts) — it must feel made by a person, not a template:
- The first 1.5 seconds decide everything: open on the most surprising, emotional or useful moment — not on "hi everyone". Pull a strong moment forward if needed.
- One short "hook" overlay (2-6 words) over the opening ~2 seconds that teases the payoff. Keep other on-screen text rare and purposeful — not a title on every shot.
- Keep it moving but human: cut out dead air and retakes, yet keep the natural rhythm of speech and the odd real reaction or breath. Vary shot lengths (some 1 s, some 3-4 s) — never a mechanical every-N-seconds pattern.
- Mostly straight cuts. Use a transition only where the story changes place or time. Effects ("kenburns"/"punch-in") sparingly, where they help.
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
  "music": { "track": "m1", "start": 0 },  // ONLY when a music section is given below; omit otherwise
  "emphasis": [                            // ONLY when captions are on: words the captions should make pop
    { "word": "timber", "emoji": "🌲" }    // a single spoken word; emoji optional (null) — at most 1 in 3 gets one
  ]
}`;

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
- A natural AI voice (${vo.voiceLabel}) reads each line. Write how people talk, not how they write: short sentences (max ~16 words), contractions, concrete words. The first line is the hook and starts at ~0.3 s.
- Leave room to breathe: about 2.5 words per second, total speech at most ~70% of the version's length, lines in order and never overlapping.
- Never narrate over moments where someone on camera is talking. Under narration set those scenes' "volume" to 0.15-0.35 so the natural sound stays as texture.
- Narration is turned into captions automatically — do not add text overlays repeating it.
`;
  const music = options.music;
  const musicSection = !music || music.mode === 'off' ? '' : `
## Music
${music.mode === 'fixed'
    ? `The user chose track ${music.fixed} (listed below). Set "music": { "track": "${music.fixed}", "start": <seconds into the track where the best part begins> }.`
    : `Pick ONE background track from the user's music library that fits the mood and pacing, and set "music": { "track": "<id>", "start": <seconds into the track to begin> }. Choose from the names/tags; if none fits, still pick the closest.`}
Music plays under the whole video and is automatically lowered while someone speaks. When the music leads (montage, POV, no talking), set scene "volume" to 0.2-0.5 so natural sound stays as texture — unless the user wants the original sound up front.
${music.tracks.map((t) => `- ${t.id}: "${t.name}" · ${round(t.duration)}s${t.tags ? ` · ${t.tags}` : ''}`).join('\n')}
`;

  return `You are ClipForge's edit planner — a senior short-form video editor. ${seeing} Produce precise edit decision lists.

## RULE #1 — do exactly what the user asks
The user's request below is the highest authority. Follow every instruction literally: specified text is used word for word, specified order/timing/transitions/clips are respected, anything they say to remove is removed. The style guide further down only fills gaps the user left open; never let it override an explicit instruction. Record every instruction and how you handled it in "checklist".

## User's request
"""
${userPrompt}
"""

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
${musicSection}${voiceoverSection}
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

## Response format
Respond with ONE JSON object and nothing else — no prose, no markdown fences. Shape (comments are explanatory, omit them):
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

  for (let attempt = 1; attempt <= 2; attempt++) {
    const input =
      attempt === 1
        ? prompt
        : `${prompt}\n\n## Your previous answer was rejected\nReason: ${lastError.message}\nPrevious answer (truncated):\n${raw.slice(0, 4000)}\n\nReturn the corrected JSON object only.`;

    onStatus?.(attempt === 1 ? 'Claude is planning the edit…' : 'Plan was invalid — asking Claude to fix it…');
    raw = await callClaude(input, { cwd, signal, model: options.model, tools: clips.some((c) => c.sheet) ? 'Read' : '' });

    try {
      const result = normalizeResponse(extractJson(raw), clips, options);
      return { ...result, prompt, raw };
    } catch (err) {
      lastError = err;
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

/** Pull a JSON object out of a model response (tolerates fences or stray prose). */
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
    for (const variant of [c, c.replace(/\/\/[^\n"]*$/gm, '')]) {
      try {
        const v = JSON.parse(variant);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch {
        /* try next */
      }
    }
  }
  throw new Error('response was not a JSON object');
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
      warnings.push('Claude did not choose a music track — the video has no music.');
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

  return { title: String(raw.title || 'ClipForge edit').slice(0, 120), checklist, versions, warnings, music, emphasis };
}

/** Output length of a normalized plan (sum of scene lengths minus transition overlaps). */
export function planLength(plan) {
  let total = 0;
  plan.scenes.forEach((s, i) => {
    const d = (s.end - s.start) / s.speed;
    const overlap = i > 0 && !['cut', 'fadeblack'].includes(s.transition) ? Math.min(s.transitionDuration, d / 2) : 0;
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
      note: typeof s.note === 'string' ? s.note : '',
    });
  });

  if (scenes.length === 0) throw new Error('no scene referenced a valid clip/time range');

  // The very first scene has nothing to transition from; only a fade from black makes sense.
  if (!['cut', 'fadeblack'].includes(scenes[0].transition)) scenes[0].transition = 'fadeblack';

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

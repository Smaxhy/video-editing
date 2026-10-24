import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run, tail, exists, linkOrCopy, round, clamp, escapeHtml, PipelineError } from './util.js';
import { sfxCues, SFX_VOLUME, SFX_LENGTH } from './sfx.js';
import { cameraPath } from './reframe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_HYPERFRAMES = path.join(ROOT, 'node_modules', '.bin', 'hyperframes');
const GSAP_LOCAL = path.join(ROOT, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
const GSAP_CDN = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';

export const FORMATS = {
  '9x16': { width: 1080, height: 1920, label: '9:16 Vertical', use: 'TikTok · Reels · Shorts · Stories' },
  '4x5': { width: 1080, height: 1350, label: '4:5 Feed', use: 'Instagram & Facebook feed ads' },
  '1x1': { width: 1080, height: 1080, label: '1:1 Square', use: 'Feeds · LinkedIn · X' },
  '16x9': { width: 1920, height: 1080, label: '16:9 Landscape', use: 'YouTube · web · pre-roll' },
};
export const CAPTION_STYLES = ['off', 'clean', 'bold', 'pop'];
export const FRAMINGS = ['smart', 'blur', 'face', 'crop', 'fit'];

// Transitions where the incoming scene overlaps the tail of the previous one.
const OVERLAP_TRANSITIONS = new Set(['crossfade', 'slide-left', 'slide-up', 'zoom', 'wipe', 'zoom-through', 'whip', 'spin', 'light-leak']);
const FPS = 30;

/**
 * Lay the plan's scenes out on the output timeline.
 * Each scene keeps its source range (srcStart/srcEnd) and gains its timeline position
 * (tlStart, duration) plus the fade/overlap lengths at each edge.
 */
export function layoutTimeline(plan) {
  const out = [];
  let cursor = 0;
  plan.scenes.forEach((s, i) => {
    const duration = (s.end - s.start) / s.speed;
    const prev = out[i - 1];
    let start = cursor;
    let overlapIn = 0;
    let fadeIn = 0;

    if (prev && OVERLAP_TRANSITIONS.has(s.transition)) {
      overlapIn = Math.min(s.transitionDuration, duration / 2, prev.duration / 2);
      start = prev.tlStart + prev.duration - overlapIn;
      prev.overlapOut = overlapIn;
    } else if (s.transition === 'fadeblack') {
      // Fade-through-black: previous scene fades out over the first half, this one fades in over the second.
      const half = Math.min(s.transitionDuration / 2, duration / 2, prev ? prev.duration / 2 : Infinity);
      fadeIn = prev ? half : Math.min(s.transitionDuration, duration / 2);
      if (prev) prev.fadeOut = half;
    }

    out.push({
      ...s,
      index: i,
      srcStart: s.start,
      srcEnd: s.end,
      tlStart: round(start, 3),
      duration: round(duration, 3),
      overlapIn,
      overlapOut: 0,
      fadeIn,
      fadeOut: 0,
    });
    cursor = start + duration;
  });
  const total = round(Math.max(...out.map((s) => s.tlStart + s.duration)), 3);
  return { scenes: out, total };
}

/**
 * Caption grouping per style. Short-form research: 1–3 words per group for high energy, breaking
 * at natural pauses; clean subtitles read best at up to ~38 characters; SRT sidecars at 42.
 */
const CAPTION_RULES = {
  bold: { maxWords: 3, maxChars: 18, pause: 0.35 },
  pop: { maxWords: 2, maxChars: 11, pause: 0.25, single: true },
  clean: { maxWords: 7, maxChars: 38, pause: 0.6 },
  srt: { maxWords: 12, maxChars: 42, pause: 0.8 },
};
const tidyWord = (w) => String(w).trim();
/** Lower-case word without punctuation, for matching emphasis words. */
export const wordKey = (w) => String(w).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Turn Whisper word timings inside each scene's source range into caption cues on the output
 * timeline. Each cue keeps its words with their own output-timeline times (for karaoke highlighting).
 */
export function buildCaptions(timeline, transcripts, style, { upperCase } = {}) {
  if (style === 'off') return [];
  const rule = CAPTION_RULES[style] || CAPTION_RULES.bold;
  const cues = [];

  for (const sc of timeline.scenes) {
    const t = transcripts[sc.clip];
    if (!t) continue;
    const { srcStart, srcEnd } = sc;
    const sceneEnd = sc.tlStart + sc.duration;
    const map = (src) => sc.tlStart + (clamp(src, srcStart, srcEnd) - srcStart) / sc.speed;
    const words = (t.words?.length ? t.words : segmentsToWords(t.segments || []))
      .filter((w) => w.end > srcStart + 0.05 && w.start < srcEnd - 0.05 && tidyWord(w.word))
      // Whisper sometimes gives a word ~0 s; give it a readable minimum so the highlight is visible.
      .map((w) => ({ ...w, word: tidyWord(w.word), end: Math.max(w.end, w.start + 0.08) }));

    let group = [];
    const flush = () => {
      if (!group.length) return;
      const text = group.map((w) => w.word).join(' ').replace(/\s+([,.!?;:])/g, '$1');
      const start = map(group[0].start);
      const end = Math.min(Math.max(map(group[group.length - 1].end) + 0.15, start + 0.4), sceneEnd);
      const upper = upperCase ?? (style === 'bold' || style === 'pop');
      const cueWords = group.map((w) => ({ text: upper ? w.word.toUpperCase() : w.word, start: round(map(w.start), 3), end: round(map(w.end), 3) }));
      cues.push({ start, end, text: upper ? text.toUpperCase() : text, words: cueWords });
      group = [];
    };
    for (const w of words) {
      const prev = group[group.length - 1];
      const nextLen = group.reduce((n, g) => n + g.word.length + 1, 0) + w.word.length;
      // "pop" shows one word at a time, but keeps tiny words ("a", "of") with their neighbour.
      const full = rule.single ? group.length >= 1 && !(group.length === 1 && group[0].word.length <= 3) : group.length >= rule.maxWords;
      if (prev && (w.start - prev.end > rule.pause || full || nextLen > rule.maxChars || /[.!?]$/.test(prev.word))) {
        flush();
      }
      group.push(w);
    }
    flush();
  }

  // Captions never overlap: each one ends where the next begins.
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  const total = Math.max(0, ...timeline.scenes.map((s) => s.tlStart + s.duration));
  return cues
    .map((c) => ({ ...c, end: Math.min(c.end, total) }))
    .filter((c) => c.end - c.start >= 0.15)
    .map((c) => ({ ...c, start: round(c.start, 3), end: round(c.end, 3) }));
}

/** Captions for an AI voiceover (words on the output timeline), merged in; narration wins overlaps. */
export function withNarration(cues, narration, total, style, opts = {}) {
  if (!narration?.words?.length || style === 'off') return cues;
  const scene = { clip: '__narration', srcStart: 0, srcEnd: total, tlStart: 0, duration: total, speed: 1 };
  const narr = buildCaptions({ scenes: [scene] }, { __narration: { words: narration.words } }, style, opts);
  const free = cues.filter((c) => !narr.some((n) => c.start < n.end && c.end > n.start));
  return [...free, ...narr].sort((a, b) => a.start - b.start);
}

/** SubRip subtitles (sentence-sized cues) for uploading as closed captions. */
export function toSrt(cues) {
  const ts = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

function segmentsToWords(segments) {
  // Fallback when Whisper gave no word timestamps: spread each segment's words evenly.
  return segments.flatMap((s) => {
    const parts = s.text.split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(parts.length, 1);
    return parts.map((word, i) => ({ word, start: s.start + i * step, end: s.start + (i + 1) * step }));
  });
}

/**
 * Volume automation for background music: full level where nobody talks, ducked to `ducked`
 * under speech (with short ramps). Speech gaps under a second are bridged so music doesn't pump.
 */
export function musicAutomation(speech, total, base, ducked) {
  const RAMP = 0.3;
  const merged = [];
  for (const c of [...speech].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && c.start - last.end < 0.8) last.end = Math.max(last.end, c.end);
    else merged.push({ start: c.start, end: c.end });
  }
  const pts = [{ t: 0, v: base }];
  for (const { start, end } of merged) {
    const down = Math.max(pts[pts.length - 1].t, start - RAMP);
    pts.push({ t: round(down, 3), v: pts[pts.length - 1].v }, { t: round(Math.max(down, start), 3), v: ducked });
    const up = Math.min(total, end + 0.1);
    pts.push({ t: round(up, 3), v: ducked }, { t: round(Math.min(total, up + 0.6), 3), v: base });
  }
  if (pts[pts.length - 1].t < total) pts.push({ t: round(total, 3), v: pts[pts.length - 1].v });
  return pts.filter((p, i) => i === 0 || p.t >= pts[i - 1].t);
}

/**
 * Cut a music track to the video: start at `start`, loop if it's too short, fade in/out, and
 * normalize loudness so every track sits at the same level before the mix volume is applied.
 */
export async function prepareMusic(srcPath, outPath, { start = 0, duration, signal }) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const fadeOut = Math.min(2.5, duration / 3);
  const res = await run('ffmpeg', [
    '-v', 'error', '-y', '-stream_loop', '-1', '-ss', String(start), '-i', srcPath, '-t', String(duration), '-vn',
    // Starting mid-track (on a loud part or so the drop hits the peak) the music must hit with the
    // hook — a click-free 80 ms fade; from the top of a track a gentle fade-in.
    '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=${start > 1 ? 0.08 : Math.min(0.6, duration / 4).toFixed(2)},afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`,
    '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', outPath,
  ], { signal });
  if (res.code !== 0) throw new PipelineError('Could not prepare the music track.', { detail: tail(res.stderr) });
  return outPath;
}

/** True when the source aspect ratio differs noticeably from the output frame. */
export function aspectMismatch(clip, W, H) {
  if (!clip.width || !clip.height) return false;
  return Math.abs(Math.log(clip.width / clip.height / (W / H))) > 0.08;
}

/** Median face centre (0-1 of the source frame) inside a source time range, or null. */
export function faceCenter(faces, start, end) {
  const inRange = (faces || []).filter((f) => f.t >= start - 0.25 && f.t <= end + 0.25);
  if (!inRange.length) return null;
  const med = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return { x: med(inRange.map((f) => f.x)), y: med(inRange.map((f) => f.y)) };
}

/**
 * CSS object-position that keeps a face centred when a clip is cover-cropped into W×H,
 * plus the face's on-screen position (used as the zoom origin for punch-ins).
 */
export function coverPositionFor(face, clip, W, H) {
  const scale = Math.max(W / clip.width, H / clip.height);
  const sw = clip.width * scale;
  const sh = clip.height * scale;
  const axis = (c, size, box) => {
    if (size - box < 1) return { pct: 50, screen: c };
    const off = clamp(c * size - box / 2, 0, size - box);
    return { pct: (off / (size - box)) * 100, screen: (c * size - off) / box };
  };
  const x = axis(face.x, sw, W);
  const y = axis(face.y, sh, H);
  const f = (n) => `${round(n, 2)}%`;
  return { position: `${f(x.pct)} ${f(y.pct)}`, origin: `${f(x.screen * 100)} ${f(y.screen * 100)}` };
}

/**
 * Build the HyperFrames HTML composition for one plan in one frame format.
 * clips: [{ id, file, hasAudio, width, height, blurFile? }], transcripts: { [clipId]: transcript }
 * settings: { width, height, captions, framing, accent }
 */
/**
 * Styled two-shot transitions (GSAP tween strings): the outgoing shot `prevId` exits while the incoming
 * `id` lands, over the transition overlap `d` starting at `at`. Blur sizes scale with the frame (`u`).
 */
const STYLED = {
  'zoom-through': ({ id, prevId, d, at, u }) => [
    `tl.to("#${prevId}", { scale: 1.6, filter: "blur(${Math.round(16 * u)}px)", duration: ${d}, ease: "power3.in" }, ${at});`,
    `tl.fromTo("#${id}", { scale: 1.6, filter: "blur(${Math.round(16 * u)}px)" }, { scale: 1, filter: "blur(0px)", duration: ${d}, ease: "power3.out" }, ${at});`,
    `tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${round(d * 0.45, 3)}, ease: "none" }, ${round(at + d * 0.25, 3)});`,
  ],
  whip: ({ id, prevId, d, at, i }) => [
    `tl.to("#${prevId}", { xPercent: -45, duration: ${d}, ease: "power2.in" }, ${at});`,
    `tl.to("#mb${i - 1}g", { attr: { stdDeviation: "70 0" }, duration: ${d}, ease: "power2.in" }, ${at});`,
    `tl.fromTo("#${id}", { xPercent: 45, opacity: 0 }, { xPercent: 0, opacity: 1, duration: ${d}, ease: "power3.out" }, ${at});`,
    `tl.fromTo("#mb${i}g", { attr: { stdDeviation: "70 0" } }, { attr: { stdDeviation: "0 0" }, duration: ${d}, ease: "power3.out" }, ${at});`,
  ],
  spin: ({ id, prevId, d, at, u }) => [
    `tl.to("#${prevId}", { rotation: -28, scale: 1.5, filter: "blur(${Math.round(10 * u)}px)", duration: ${d}, ease: "power2.in" }, ${at});`,
    `tl.fromTo("#${id}", { rotation: 28, scale: 1.5, filter: "blur(${Math.round(10 * u)}px)" }, { rotation: 0, scale: 1, filter: "blur(0px)", duration: ${d}, ease: "power3.out" }, ${at});`,
    `tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${round(d * 0.4, 3)}, ease: "none" }, ${round(at + d * 0.2, 3)});`,
  ],
  'light-leak': ({ id, d, at }) => [
    `tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${d}, ease: "sine.inOut" }, ${at});`,
  ],
};

export function buildComposition({ plan, clips, transcripts, settings, gsapSrc = 'gsap.min.js' }) {
  const { width: W, height: H } = settings;
  const u = Math.min(W, H) / 1080; // type scale relative to a 1080px short edge
  const px = (n) => `${Math.round(n * u)}px`;
  const tall = H / W; // 1.78 vertical, 1.25 feed, 1 square, 0.56 landscape
  // Platform UI safe zones (TikTok/Reels cover the bottom ~20% and the top bar on vertical video).
  const safeTop = Math.round(H * (tall > 1.5 ? 0.11 : 0.07));
  const safeBottom = Math.round(H * (tall > 1.5 ? 0.22 : tall > 1.1 ? 0.12 : 0.08));
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accent || '') ? settings.accent : '#7c5cff';
  // Captions clear the platform UI: ~27% from the bottom on 9:16 (caption text, buttons, nav bar).
  // "middle" (a style choice): lower-middle of the frame, where many creators put their captions.
  const capBottom = Math.round(H * (settings.captionPos === 'middle' ? 0.4 : tall > 1.5 ? 0.27 : tall > 1.1 ? 0.14 : 0.1));
  const fontFaces = [
    settings.fontFiles?.display && `    @font-face { font-family: "CF Display"; src: url("fonts/${settings.fontFiles.display}"); }`,
    settings.fontFiles?.body && `    @font-face { font-family: "CF Body"; src: url("fonts/${settings.fontFiles.body}"); font-weight: 100 900; }`,
  ].filter(Boolean).join('\n');
  const displayFont = `${settings.fontFiles?.display ? '"CF Display", ' : ''}Impact, "Arial Narrow Bold", sans-serif`;
  const bodyFont = `${settings.fontFiles?.body ? '"CF Body", ' : ''}system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  const clipById = new Map(clips.map((c) => [c.id, c]));

  const laid = layoutTimeline(plan);
  const total = laid.total;
  // Captions step aside for CTA end cards so the call to action reads cleanly.
  // Captions step aside for CTA end cards, and for any title/hook/text that sits in the same part of
  // the frame (middle captions vs centred titles, bottom captions vs bottom text) — never two layers of text.
  const capZone = settings.captionPos === 'middle' ? 'center' : 'bottom';
  const ctas = plan.overlays.filter((o) => o.type === 'cta' || (o.type !== 'lower-third' && o.position === capZone));
  const capOpts = { upperCase: settings.captionCase ? settings.captionCase === 'upper' : undefined };
  const captions = withNarration(buildCaptions(laid, transcripts, settings.captions, capOpts), settings.narration, total, settings.captions, capOpts)
    .map((c) => {
      for (const o of ctas) {
        if (c.start >= o.start - 0.05 && c.start < o.end) return null;
        if (c.start < o.start && c.end > o.start) c = { ...c, end: o.start };
      }
      return c.end - c.start >= 0.15 ? c : null;
    })
    .filter(Boolean);

  const tweens = [];
  // Motion level: "off", "subtle" (default — what a human editor does: hide jump cuts, gentle pushes)
  // or "punchy" (adds key-word zooms and beat pulses). `true` from older settings = punchy.
  const motion = settings.motion === true ? 'punchy' : settings.motion || 'off';
  const punchy = motion === 'punchy';
  const jumpZoom = punchy ? 1.12 : 1.08;
  const push = punchy ? 1.04 : 1.025;
  let lastEmphasisZoom = -Infinity;
  // Jump cuts (same clip, straight cut, a little further on) alternate between normal and a 112%
  // punch-in so they look intentional — the standard talking-head trick.
  const zoom = [];
  laid.scenes.forEach((s, i) => {
    const p = laid.scenes[i - 1];
    const jump = motion !== 'off' && p && !s.ramp && p.clip === s.clip && s.transition === 'cut' && s.srcStart >= p.srcEnd - 0.05 && s.srcStart - p.srcEnd < 3;
    zoom[i] = jump ? (zoom[i - 1] > 1 ? 1 : jumpZoom) : 1;
  });
  const emphasisKeys = new Set((settings.emphasis || []).map((e) => wordKey(e.word)));
  // Scenes on either side of a whip pan get a horizontal motion-blur filter.
  const whip = new Set();
  laid.scenes.forEach((sc, i) => sc.transition === 'whip' && sc.overlapIn > 0 && whip.add(i).add(i - 1));
  const leaks = [];
  const flashes = [];
  const glitches = [];
  const sceneHtml = laid.scenes.map((s, i) => {
    const clip = clipById.get(s.clip);
    const id = `s${i}`;
    const dur = s.duration;
    const end = s.tlStart + dur;
    const ease = 'power2.inOut';

    // Visual entrance
    const prevId = `s${i - 1}`;
    if (s.overlapIn > 0 && STYLED[s.transition]) {
      // Styled transitions animate both shots: the outgoing one exits, the incoming one lands.
      const d = round(s.overlapIn, 3);
      for (const t of STYLED[s.transition]({ id, prevId, d, at: s.tlStart, i, u })) tweens.push(t);
      if (s.transition === 'light-leak') leaks.push({ at: s.tlStart, d, i });
    } else if (s.overlapIn > 0) {
      const d = round(s.overlapIn, 3);
      const from = {
        crossfade: '{ opacity: 0 }',
        'slide-left': '{ xPercent: 100 }',
        'slide-up': '{ yPercent: 100 }',
        zoom: '{ opacity: 0, scale: 1.25 }',
        wipe: '{ clipPath: "inset(0 100% 0 0)" }',
      }[s.transition];
      const to = {
        crossfade: 'opacity: 1',
        'slide-left': 'xPercent: 0',
        'slide-up': 'yPercent: 0',
        zoom: 'opacity: 1, scale: 1',
        wipe: 'clipPath: "inset(0 0% 0 0)"',
      }[s.transition];
      tweens.push(`tl.fromTo("#${id}", ${from}, { ${to}, duration: ${d}, ease: "${ease}" }, ${s.tlStart});`);
    } else if (s.fadeIn > 0) {
      tweens.push(`tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${round(s.fadeIn, 3)}, ease: "none" }, ${s.tlStart});`);
    }
    // Cut-like styled transitions: the cut stays on time, the incoming shot does the move.
    if (i > 0 && s.transition === 'punch') {
      tweens.push(`tl.fromTo("#${id}", { scale: 1.32, filter: "blur(${Math.round(12 * u)}px)" }, { scale: 1, filter: "blur(0px)", duration: 0.32, ease: "expo.out" }, ${s.tlStart});`);
    } else if (i > 0 && s.transition === 'flash') {
      flashes.push(s.tlStart);
      tweens.push(`tl.fromTo("#${id}", { scale: 1.08 }, { scale: 1, duration: 0.35, ease: "power2.out" }, ${s.tlStart});`);
    } else if (i > 0 && s.transition === 'glitch') {
      const g = Math.round(40 * u);
      tweens.push(`tl.set("#${id}", { x: ${-g}, filter: "hue-rotate(80deg) saturate(2.4) contrast(1.4)" }, ${s.tlStart});`);
      tweens.push(`tl.to("#${id}", { keyframes: [{ x: ${g}, duration: 0.05 }, { x: ${-Math.round(g / 2)}, duration: 0.05 }, { x: ${Math.round(g / 3)}, filter: "hue-rotate(-40deg) saturate(1.8) contrast(1.2)", duration: 0.05 }, { x: 0, filter: "hue-rotate(0deg) saturate(1) contrast(1)", duration: 0.07 }] }, ${s.tlStart});`);
      glitches.push(s.tlStart);
    }
    // Visual exit (fade to black before a fadeblack transition)
    if (s.fadeOut > 0) {
      tweens.push(
        `tl.fromTo("#${id}", { opacity: 1 }, { opacity: 0, duration: ${round(s.fadeOut, 3)}, ease: "none", immediateRender: false }, ${round(end - s.fadeOut, 3)});`,
      );
    }
    // In-scene camera move on the inner wrapper (never on the timed <video> itself)
    const z = zoom[i];
    if (s.effect === 'kenburns') {
      tweens.push(`tl.fromTo("#${id}i", { scale: ${z} }, { scale: ${round(z * 1.1, 3)}, duration: ${round(dur, 3)}, ease: "none" }, ${s.tlStart});`);
    } else if (s.effect === 'punch-in') {
      tweens.push(`tl.fromTo("#${id}i", { scale: ${round(Math.max(z, 1.15), 3)} }, { scale: ${round(Math.max(z, 1.15) * 1.04, 3)}, duration: ${round(dur, 3)}, ease: "none" }, ${s.tlStart});`);
    } else if (motion !== 'off' && dur > 3.5) {
      // Never a dead-still frame: a slow push over long shots.
      tweens.push(`tl.fromTo("#${id}i", { scale: ${z} }, { scale: ${round(z * push, 3)}, duration: ${round(dur, 3)}, ease: "none" }, ${s.tlStart});`);
    } else if (z !== 1) {
      tweens.push(`tl.set("#${id}i", { scale: ${z} }, ${s.tlStart});`);
    }
    if (s.effect === 'shake') {
      // Impact: a 0.35 s handheld jolt (slight zoom so the frame edges never show).
      const a = Math.round(26 * u);
      tweens.push(`tl.fromTo("#${id}p", { scale: 1.06 }, { scale: 1, duration: 0.5, ease: "power2.out" }, ${s.tlStart});`);
      tweens.push(`tl.to("#${id}i", { keyframes: [{ x: ${a}, y: ${-a}, duration: 0.04 }, { x: ${-a}, y: ${Math.round(a * 0.7)}, duration: 0.05 }, { x: ${Math.round(a * 0.6)}, y: ${Math.round(a * 0.4)}, duration: 0.05 }, { x: ${-Math.round(a * 0.4)}, y: ${-Math.round(a * 0.3)}, duration: 0.06 }, { x: 0, y: 0, duration: 0.08 }] }, ${s.tlStart});`);
    }
    // On the beat: B-roll / POV scenes get a small 3% pulse on every downbeat of the music.
    const sceneWords = (transcripts[s.clip]?.words || []).filter((w) => w.end > s.srcStart && w.start < s.srcEnd);
    if (punchy && settings.downbeats?.length && sceneWords.length < 3) {
      for (const b of settings.downbeats) {
        if (b <= s.tlStart + 0.15 || b >= end - 0.3) continue;
        tweens.push(`tl.fromTo("#${id}p", { scale: 1 }, { scale: 1.03, duration: 0.06, ease: "power2.out", yoyo: true, repeat: 1, repeatDelay: 0.04 }, ${round(b - 0.02, 3)});`);
      }
    }
    // Emphasis zoom: a quick 7% punch on the first key word of a talking scene.
    // Subtle: at most one key-word zoom every ~8 s; punchy: one per talking scene.
    if (motion !== 'off' && emphasisKeys.size && transcripts[s.clip]?.words?.length) {
      const hit = transcripts[s.clip].words.find((w) => {
        if (!emphasisKeys.has(wordKey(w.word)) || w.start < s.srcStart || w.start >= s.srcEnd) return false;
        const at = s.tlStart + (w.start - s.srcStart) / s.speed;
        return at > s.tlStart + 0.5 && at < end - 0.8 && at - lastEmphasisZoom >= (punchy ? 0 : 8);
      });
      if (hit) {
        const at = round(s.tlStart + (hit.start - s.srcStart) / s.speed, 3);
        lastEmphasisZoom = at;
        tweens.push(`tl.fromTo("#${id}p", { scale: 1 }, { scale: 1.07, duration: 0.14, ease: "power2.out" }, ${at});`);
      }
    }

    // Audio: the clip's own sound stays on the <video>; fades ride a volume automation lane.
    const isFirst = i === 0;
    const isLast = i === laid.scenes.length - 1;
    const v = s.volume;
    // A 20 ms fade at every splice: hard audio cuts click; pro editors always add a tiny crossfade.
    const SPLICE = 0.02;
    let audioIn = Math.max(s.overlapIn, s.fadeIn, isFirst ? plan.audio.fadeIn : 0, SPLICE);
    let audioOut = Math.max(s.overlapOut, s.fadeOut, isLast ? plan.audio.fadeOut : 0, SPLICE);
    if (audioIn + audioOut > dur) {
      const k = dur / (audioIn + audioOut);
      audioIn *= k;
      audioOut *= k;
    }
    // Sound comes from the clip itself, or from its Demucs-isolated voice track when available.
    const audible = clip.hasAudio && v > 0;
    let volumeAttrs;
    if (audioIn > 0 || audioOut > 0) {
      const pts = [];
      if (audioIn > 0) pts.push({ t: 0, v: 0 }, { t: round(audioIn, 3), v });
      else pts.push({ t: 0, v });
      if (audioOut > 0) pts.push({ t: round(dur - audioOut, 3), v }, { t: round(dur, 3), v: 0 });
      else pts.push({ t: round(dur, 3), v });
      const automation = JSON.stringify({ version: 1, lanes: [{ target: 'volume', points: pts }] });
      volumeAttrs = `data-volume="1" data-automation='${automation}'`;
    } else {
      volumeAttrs = `data-volume="${round(v, 3)}"`;
    }
    const useVoice = audible && clip.voiceFile;
    const videoAudioAttrs = audible && !useVoice ? `data-has-audio="true" ${volumeAttrs}` : 'muted';

    // Framing: fill the frame when the aspect matches; otherwise blur-fill, face-tracked crop,
    // centre crop or letterbox.
    const mismatch = aspectMismatch(clip, W, H);
    const useBlur = mismatch && settings.framing === 'blur' && clip.blurFile;
    const fit = !mismatch || ['crop', 'face', 'smart'].includes(settings.framing) ? 'cover' : 'contain';
    let position = '50% 50%';
    let origin = '50% 50%';
    if (mismatch && settings.framing === 'face') {
      const face = faceCenter(clip.faces, s.srcStart, s.srcEnd);
      if (face) ({ position, origin } = coverPositionFor(face, clip, W, H));
    }
    // Smart reframe: a locked-off crop on the subject, or a smooth tracking camera that follows it.
    if (mismatch && settings.framing === 'smart') {
      const cam = cameraPath(clip.track, s, clip, W, H);
      if (cam?.keys) {
        position = `${cam.keys[0].x}% ${cam.keys[0].y}%`;
        for (let k = 1; k < cam.keys.length; k++) {
          const a = cam.keys[k - 1];
          const b = cam.keys[k];
          if (b.t - a.t < 0.05) continue;
          tweens.push(`tl.to("#v${i}", { objectPosition: "${b.x}% ${b.y}%", duration: ${round(b.t - a.t, 3)}, ease: "sine.inOut" }, ${round(s.tlStart + a.t, 3)});`);
        }
      } else if (cam) {
        position = `${cam.x}% ${cam.y}%`;
      }
    }

    const timing = `data-start="${s.tlStart}" data-duration="${round(dur, 3)}" data-media-start="${round(s.srcStart, 3)}"${
      s.speed !== 1 ? ` data-playback-rate="${s.speed}"` : ''
    }`;
    const bg = useBlur
      ? `\n      <video id="b${i}" class="bg" src="media/${escapeHtml(clip.blurFile)}" ${timing} data-track-index="${20 + (i % 2)}" muted playsinline></video>`
      : '';
    // A polished copy covers only the used range, so it starts `videoOffset` seconds into the clip.
    const videoTiming = clip.videoOffset
      ? `data-start="${s.tlStart}" data-duration="${round(dur, 3)}" data-media-start="${round(s.srcStart - clip.videoOffset, 3)}"${s.speed !== 1 ? ` data-playback-rate="${s.speed}"` : ''}`
      : timing;
    // The processed voice track may start part-way into the clip (only the used range is processed).
    const voiceTiming = `data-start="${s.tlStart}" data-duration="${round(dur, 3)}" data-media-start="${round(s.srcStart - (clip.voiceOffset || 0), 3)}"${
      s.speed !== 1 ? ` data-playback-rate="${s.speed}"` : ''
    }`;
    const voice = useVoice
      ? `\n      <audio id="a${i}" src="media/${escapeHtml(clip.voiceFile)}" ${voiceTiming} data-track-index="${30 + (i % 2)}" ${volumeAttrs}></audio>`
      : '';
    return `    <div id="${id}" class="scene">${bg}
      <div id="${id}i" class="inner" style="transform-origin: ${origin}${whip.has(i) ? `; filter: url(#mb${i})` : ''}"><div id="${id}p" class="inner" style="transform-origin: ${origin}">
        <video id="v${i}" src="media/${escapeHtml(clip.file)}" ${videoTiming} data-track-index="${i % 2}" playsinline ${videoAudioAttrs} style="object-fit: ${fit}; object-position: ${position}"></video>
      </div></div>${voice}
    </div>`;
  });

  // Overlays. Stacking (bottom → top): lower-thirds/text, captions, hooks/titles, CTA end card.
  const layer = { 'lower-third': 0, text: 0, caption: 0, hook: 1, title: 1, cta: 2 };
  const overlays = plan.overlays
    .map((o, i) => ({ ...o, i, end: Math.min(o.end, total) }))
    .filter((o) => o.start < total && o.end - o.start >= 0.2);

  const logo = settings.logoFile ? `<img class="logo" src="media/${escapeHtml(settings.logoFile)}" alt="" />` : '';
  const overlayHtml = overlays.map((o) => {
    const id = `o${o.i}`;
    const dur = round(o.end - o.start, 3);
    const inD = round(Math.min(0.45, dur / 3), 3);
    const outD = round(Math.min(0.3, dur / 4), 3);
    const at = (t) => round(t, 3);
    if (o.type === 'hook' || o.type === 'cta') {
      // Pop in with a little overshoot — the social-native feel.
      tweens.push(`tl.fromTo("#${id}i", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: ${Math.min(inD, 0.3)}, ease: "back.out(2.2)" }, ${o.start});`);
    } else if (o.type === 'lower-third') {
      tweens.push(`tl.fromTo("#${id}i", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: ${inD}, ease: "power3.out" }, ${o.start});`);
    } else {
      tweens.push(`tl.fromTo("#${id}i", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: ${inD}, ease: "power3.out" }, ${o.start});`);
    }
    if (o.type === 'cta') {
      tweens.push(`tl.fromTo("#${id}s", { opacity: 0 }, { opacity: 1, duration: ${inD}, ease: "none" }, ${o.start});`);
      // Gentle pulse on the button so the end card isn't static.
      tweens.push(`tl.fromTo("#${id}b", { scale: 1 }, { scale: 1.06, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: ${Math.max(0, Math.floor((dur - inD) / 0.5) - 1)} }, ${at(o.start + inD)});`);
    }
    // CTA end cards hold to the last frame; everything else fades out just before its end.
    const holdsToEnd = o.type === 'cta' && o.end >= total - 0.05;
    if (!holdsToEnd) {
      tweens.push(
        `tl.fromTo("#${id}i", { opacity: 1 }, { opacity: 0, duration: ${outD}, ease: "power1.in", immediateRender: false }, ${at(o.end - outD - 0.04)});`,
      );
    }
    const text = escapeHtml(o.text);
    const sub = o.subtext ? `<div class="sub">${escapeHtml(o.subtext)}</div>` : '';
    const body =
      o.type === 'cta'
        ? `<div id="${id}s" class="scrim"></div><div id="${id}i" class="ov-inner">${logo}${sub}<div id="${id}b" class="btn">${text}</div></div>`
        : `<div id="${id}i" class="ov-inner"><div class="main">${text}</div>${sub}</div>`;
    return {
      layer: layer[o.type],
      html: `    <div id="${id}" class="clip ov ov-${o.type} pos-${o.position}" data-start="${o.start}" data-duration="${dur}" data-track-index="${10 + layer[o.type]}">
      ${body}
    </div>`,
    };
  });

  // Captions: karaoke-style active-word highlight, keyword colour + emoji from the planner's
  // "emphasis" list, pop-in entrances. Highlight colour: the brand accent, or caption yellow.
  const style = settings.captions;
  const highlight = /^#[0-9a-f]{6}$/i.test(settings.captionColor || '') ? settings.captionColor : accent.toLowerCase() === '#7c5cff' ? '#ffe14d' : accent;
  const emphasis = new Map((settings.emphasis || []).map((e) => [wordKey(e.word), e.emoji || '']));
  let lastEmoji = -Infinity;
  const emojiTimes = [];
  const captionHtml = captions.map((c, i) => {
    const id = `cap${i}`;
    const dur = round(c.end - c.start, 3);
    if (style === 'pop') {
      const tilt = i % 2 ? 2 : -2;
      tweens.push(`tl.fromTo("#${id}i", { scale: 0.45, opacity: 0, rotation: ${-tilt} }, { scale: 1, opacity: 1, rotation: ${tilt / 2}, duration: 0.16, ease: "back.out(3)" }, ${c.start});`);
    } else if (style === 'bold') {
      tweens.push(`tl.fromTo("#${id}i", { scale: 0.85, opacity: 0, y: ${Math.round(18 * u)} }, { scale: 1, opacity: 1, y: 0, duration: 0.12, ease: "back.out(2)" }, ${c.start});`);
    } else {
      tweens.push(`tl.fromTo("#${id}i", { opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none" }, ${c.start});`);
    }
    let emoji = '';
    const words = c.words.map((w, k) => {
      const key = wordKey(w.text);
      const strong = emphasis.has(key);
      const wid = `${id}w${k}`;
      // Active word: highlight colour + a little pop (karaoke). Not for one-word "pop" captions.
      if (style !== 'pop' && c.words.length > 1) {
        const on = Math.max(c.start, w.start);
        const off = k < c.words.length - 1 ? Math.max(on + 0.06, c.words[k + 1].start) : null;
        tweens.push(`tl.to("#${wid}", { color: "${highlight}", scale: ${style === 'clean' ? 1 : 1.12}, duration: 0.07, ease: "power2.out" }, ${round(on, 3)});`);
        if (off != null && !strong) tweens.push(`tl.to("#${wid}", { color: "#ffffff", scale: 1, duration: 0.07, ease: "power1.out" }, ${round(off, 3)});`);
        else if (off != null) tweens.push(`tl.to("#${wid}", { scale: 1, duration: 0.07 }, ${round(off, 3)});`);
      }
      if (strong && emphasis.get(key) && !emoji && w.start - lastEmoji >= 2.5 && style !== 'clean') {
        emoji = emphasis.get(key);
        lastEmoji = w.start;
        emojiTimes.push(round(Math.max(c.start, w.start), 3));
        tweens.push(`tl.fromTo("#${id}e", { scale: 0, opacity: 0, rotation: -20 }, { scale: 1, opacity: 1, rotation: 0, duration: 0.22, ease: "back.out(3)" }, ${round(Math.max(c.start, w.start), 3)});`);
      }
      return `<span id="${wid}" class="w${strong ? ' em' : ''}">${escapeHtml(w.text)}</span>`;
    });
    const emojiHtml = emoji ? `<div id="${id}e" class="emoji">${escapeHtml(emoji)}</div>` : '';
    return `    <div id="${id}" class="clip cap cap-${style}" data-start="${c.start}" data-duration="${dur}" data-track-index="9"><div class="cap-box">${emojiHtml}<span id="${id}i" class="line">${words.join(' ')}</span></div></div>`;
  });
  const layerHtml = (n) => overlayHtml.filter((o) => o.layer === n).map((o) => o.html);
  // Background music: one track under the whole video, ducked wherever an audible scene has speech.
  const music = [];
  if (settings.musicFile) {
    const audibleScenes = laid.scenes.filter((sc) => sc.volume > 0 && clipById.get(sc.clip)?.hasAudio);
    const speech = [...buildCaptions({ scenes: audibleScenes }, transcripts, 'clean'), ...(settings.narration?.segments || [])];
    const base = clamp(Number(settings.musicVolume) || 0.8, 0, 1.5);
    const automation = JSON.stringify({ version: 1, lanes: [{ target: 'volume', points: musicAutomation(speech, total, base, round(base * 0.22, 3)) }] });
    music.push(`    <audio id="music" src="media/${escapeHtml(settings.musicFile)}" data-start="0" data-duration="${total}" data-track-index="50" data-volume="1" data-automation='${automation}'></audio>`);
  }
  // AI voiceover: one mixed narration track under everything (already level-matched).
  if (settings.narrationFile) {
    music.push(`    <audio id="narration" src="media/${escapeHtml(settings.narrationFile)}" data-start="0" data-duration="${total}" data-track-index="45" data-volume="1"></audio>`);
  }
  // Sound effects: whooshes into transitions, impacts on titles, pops on hooks/emoji, a riser into the CTA.
  const sfx = [];
  if (settings.sfxFiles) {
    sfxCues({ timeline: laid, overlays, emojiTimes, level: settings.sfxLevel || 'full' }).forEach((c, k) => {
      if (!settings.sfxFiles[c.name] || c.start >= total - 0.05) return;
      const d = round(Math.min(SFX_LENGTH[c.name], total - c.start), 3);
      sfx.push(`    <audio id="fx${k}" src="media/${escapeHtml(settings.sfxFiles[c.name])}" data-start="${c.start}" data-duration="${d}" data-track-index="${60 + (k % 4)}" data-volume="${SFX_VOLUME[c.name]}"></audio>`);
    });
  }
  // Brand watermark: the logo in the top-right corner for the whole video.
  const watermark =
    settings.watermark && settings.logoFile
      ? [`    <div id="wm" class="clip wm" data-start="0" data-duration="${total}" data-track-index="40"><img src="media/${escapeHtml(settings.logoFile)}" alt="" /></div>`]
      : [];

  // Transition light: white flashes, film light leaks, glitch bars — above the picture, below text.
  const fxHtml = [];
  if (whip.size) {
    fxHtml.push(`    <svg width="0" height="0" style="position:absolute"><defs>${[...whip].filter((k) => k >= 0).map((k) => `<filter id="mb${k}" x="-25%" y="0" width="150%" height="100%"><feGaussianBlur id="mb${k}g" stdDeviation="0 0" /></filter>`).join('')}</defs></svg>`);
  }
  if (flashes.length) {
    fxHtml.push('    <div id="flash" class="fx fx-flash"></div>');
    for (const t of flashes) tweens.push(`tl.fromTo("#flash", { opacity: 0.92 }, { opacity: 0, duration: 0.28, ease: "power2.out", immediateRender: false }, ${round(t, 3)});`);
  }
  if (glitches.length) {
    fxHtml.push('    <div id="glitch" class="fx fx-glitch"></div>');
    for (const t of glitches) {
      tweens.push(`tl.fromTo("#glitch", { opacity: 0.85, yPercent: 0 }, { keyframes: [{ opacity: 0.2, yPercent: 7, duration: 0.05 }, { opacity: 0.7, yPercent: -4, duration: 0.05 }, { opacity: 0, yPercent: 0, duration: 0.08 }], immediateRender: false }, ${round(t, 3)});`);
    }
  }
  leaks.forEach((l, k) => {
    fxHtml.push(`    <div id="lk${k}" class="fx fx-leak${k % 2 ? ' alt' : ''}"></div>`);
    const span = round(Math.max(0.9, l.d * 2.2), 3);
    tweens.push(`tl.fromTo("#lk${k}", { opacity: 0, xPercent: ${k % 2 ? 25 : -25} }, { keyframes: [{ opacity: 0.9, xPercent: 0, duration: ${round(span / 2, 3)}, ease: "sine.out" }, { opacity: 0, xPercent: ${k % 2 ? -25 : 25}, duration: ${round(span / 2, 3)}, ease: "sine.in" }], immediateRender: false }, ${round(Math.max(0, l.at + l.d / 2 - span / 2), 3)});`);
  });

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${W}, height=${H}" />
  <title>${escapeHtml(plan.title)}</title>
  <script src="${gsapSrc}"></script>
  <style>
${fontFaces}
    html, body { margin: 0; background: #000; }
    #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #fff; }
    .scene, .inner { position: absolute; inset: 0; }
    .scene video { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
    .fx { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
    .fx-flash { background: #fff; }
    .fx-leak { inset: -20%; mix-blend-mode: screen; background:
      radial-gradient(ellipse 45% 60% at 30% 40%, rgba(255,150,60,.95), rgba(255,90,40,.45) 45%, rgba(255,60,90,0) 75%),
      radial-gradient(ellipse 35% 50% at 75% 65%, rgba(255,210,120,.8), rgba(255,120,80,0) 70%); }
    .fx-leak.alt { background:
      radial-gradient(ellipse 50% 55% at 70% 35%, rgba(255,120,170,.9), rgba(255,140,60,.4) 50%, rgba(255,80,80,0) 75%),
      radial-gradient(ellipse 30% 45% at 25% 70%, rgba(255,230,150,.75), rgba(255,170,90,0) 70%); }
    .fx-glitch { mix-blend-mode: screen; background:
      repeating-linear-gradient(0deg, rgba(255,0,80,.55) 0 ${px(6)}, rgba(0,0,0,0) ${px(6)} ${px(26)}),
      linear-gradient(90deg, rgba(0,255,230,.35), rgba(0,0,0,0) 30%, rgba(0,0,0,0) 70%, rgba(255,0,200,.35)); }
    .scene video.bg { object-fit: cover; transform: scale(1.08); filter: brightness(0.7) saturate(1.2); }

    /* Overlay clips are full-frame boxes; HyperFrames only auto-sizes clips with no size of their own. */
    .ov, .cap { position: absolute; left: 0; top: 0; width: 100%; height: 100%; box-sizing: border-box; pointer-events: none; }
    .ov { display: flex; justify-content: center; }
    .ov-inner { max-width: 86%; text-align: center; }
    .pos-top { align-items: flex-start; padding-top: ${safeTop}px; }
    .pos-center { align-items: center; }
    .pos-bottom { align-items: flex-end; padding-bottom: ${safeBottom + Math.round(140 * u)}px; }

    .ov-hook .main { display: inline-block; background: #fff; color: #0b0b0f; font-family: ${bodyFont}; font-size: ${px(tall > 1.1 ? 88 : 74)}; font-weight: 900;
      line-height: 1.06; letter-spacing: -0.02em; padding: ${px(16)} ${px(34)}; border-radius: ${px(20)}; box-shadow: 0 ${px(12)} ${px(44)} rgba(0,0,0,.4); }
    .ov-hook .sub { margin-top: ${px(14)}; font-size: ${px(40)}; font-weight: 700; text-shadow: 0 ${px(2)} ${px(12)} rgba(0,0,0,.7); }

    .ov-title .ov-inner { background: radial-gradient(ellipse at center, rgba(0,0,0,.55), rgba(0,0,0,0) 70%); padding: ${px(40)} ${px(60)}; }
    .ov-title .main { font-size: ${px(100)}; font-weight: 800; letter-spacing: -0.02em; line-height: 1.05; text-shadow: 0 ${px(4)} ${px(24)} rgba(0,0,0,.6); }
    .ov-title .sub { margin-top: ${px(18)}; font-size: ${px(40)}; font-weight: 500; opacity: .9; text-shadow: 0 ${px(2)} ${px(12)} rgba(0,0,0,.6); }

    /* On-screen text: big, heavy and outlined so it reads on any background (the creator look). */
    .ov-text .main, .ov-caption .main { display: inline-block; font-family: ${bodyFont}; font-size: ${px(72)}; font-weight: 900; line-height: 1.08;
      letter-spacing: -0.01em; color: #fff; -webkit-text-stroke: ${px(10)} #000; paint-order: stroke fill; text-shadow: 0 ${px(8)} ${px(24)} rgba(0,0,0,.55); }
    .ov-text .sub, .ov-caption .sub { margin-top: ${px(12)}; font-family: ${bodyFont}; font-size: ${px(40)}; font-weight: 800; color: #fff;
      -webkit-text-stroke: ${px(6)} #000; paint-order: stroke fill; }

    .ov-lower-third { justify-content: flex-start; align-items: flex-end; padding: 0 0 ${safeBottom + Math.round(200 * u)}px ${px(60)}; }
    .ov-lower-third .ov-inner { text-align: left; border-left: ${px(8)} solid ${accent}; background: linear-gradient(90deg, rgba(10,10,18,.88), rgba(10,10,18,.6));
      padding: ${px(16)} ${px(32)} ${px(18)} ${px(26)}; border-radius: 0 ${px(8)} ${px(8)} 0; }
    .ov-lower-third .main { font-size: ${px(48)}; font-weight: 800; }
    .ov-lower-third .sub { font-size: ${px(30)}; font-weight: 500; opacity: .85; margin-top: ${px(4)}; }

    .ov-cta { align-items: center; }
    .ov-cta .scrim { position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,.45), rgba(0,0,0,.78)); }
    .ov-cta .ov-inner { position: relative; display: flex; flex-direction: column; align-items: center; gap: ${px(30)}; }
    .ov-cta .sub { font-size: ${px(44)}; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; opacity: .95; }
    .ov-cta .btn { display: inline-block; background: ${accent}; color: #fff; font-size: ${px(68)}; font-weight: 900; line-height: 1.1;
      padding: ${px(26)} ${px(56)}; border-radius: ${px(999)}; box-shadow: 0 ${px(14)} ${px(50)} ${accent}88; }

    .ov-cta .logo { display: block; max-width: ${Math.round(W * 0.45)}px; max-height: ${Math.round(H * 0.2)}px; object-fit: contain;
      filter: drop-shadow(0 ${px(8)} ${px(24)} rgba(0,0,0,.5)); }
    .wm { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }
    .wm img { position: absolute; top: ${safeTop}px; right: ${px(44)}; max-height: ${px(84)}; max-width: ${px(220)}; object-fit: contain; opacity: .9;
      filter: drop-shadow(0 ${px(3)} ${px(10)} rgba(0,0,0,.45)); }

    /* Captions sit above the Reels/TikTok caption + button area and stay clear of the right-hand icons. */
    .cap { display: flex; justify-content: center; align-items: flex-end; padding-bottom: ${capBottom}px; }
    .cap .cap-box { max-width: ${tall > 1.5 ? 78 : 86}%; text-align: center; display: flex; flex-direction: column; align-items: center; }
    .cap .line { display: block; }
    .cap .w { display: inline-block; transform-origin: 50% 60%; margin: 0 0.09em; }
    .cap .emoji { font-family: "Noto Color Emoji", "Apple Color Emoji", sans-serif; font-size: ${px(style === 'pop' ? 120 : 100)}; line-height: 1;
      margin-bottom: ${px(14)}; filter: drop-shadow(0 ${px(6)} ${px(14)} rgba(0,0,0,.45)); }
    .cap-clean .line { font-family: ${bodyFont}; font-size: ${px(46)}; font-weight: 700; line-height: 1.3; background: rgba(0,0,0,.62);
      padding: ${px(10)} ${px(22)}; border-radius: ${px(12)}; }
    .cap-clean .w { opacity: .92; }
    .cap-bold .line { font-family: ${bodyFont}; font-size: ${px(80)}; font-weight: 900; line-height: 1.08; letter-spacing: -0.01em; color: #fff;
      -webkit-text-stroke: ${px(10)} #000; paint-order: stroke fill; text-shadow: 0 ${px(8)} ${px(22)} rgba(0,0,0,.6); }
    .cap-bold .w.em { color: ${highlight}; }
    .cap-pop .line { font-family: ${displayFont}; font-size: ${px(132)}; font-weight: 400; line-height: 1; letter-spacing: 0.01em; color: #fff;
      -webkit-text-stroke: ${px(12)} #000; paint-order: stroke fill; text-shadow: 0 ${px(10)} ${px(26)} rgba(0,0,0,.6); }
    .cap-pop .w.em { color: ${highlight}; font-size: 1.18em; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${total}" data-fps="${FPS}">
${[...sceneHtml, ...fxHtml, ...music, ...sfx, ...layerHtml(0), ...captionHtml, ...watermark, ...layerHtml(1), ...layerHtml(2)].join('\n')}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${tweens.join('\n    ')}
    window.__timelines["main"] = tl;
  </script>
</body>
</html>
`;
  return { html, total, captions, timeline: laid };
}

/**
 * Make a tiny blurred copy of a clip for the blur-fill background (shared by all formats).
 * Low resolution + heavy blur = a few hundred KB; CSS scales it up behind the main video.
 */
export async function makeBlurBackground(srcPath, destPath) {
  if (await exists(destPath)) return destPath;
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part.mp4`;
  const res = await run('ffmpeg', [
    '-v', 'error', '-y', '-i', srcPath, '-an',
    // Height 240 with an even width (-2) keeps libx264 happy for any source aspect.
    '-vf', 'scale=-2:240,boxblur=14:2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-r', '30', '-g', '30', tmp,
  ]);
  if (res.code !== 0) {
    await fs.rm(tmp, { force: true });
    return null; // Not fatal: the renderer falls back to letterboxing.
  }
  await fs.rename(tmp, destPath);
  return destPath;
}

/** Largest gap between keyframes in a video, in seconds (keyframe-only decode, so it's fast). */
export async function maxKeyframeInterval(file) {
  const res = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file,
  ]);
  const duration = parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).stdout);
  return largestKeyframeGap(parseKeyframeTimes(res.stdout), duration);
}

/** Keyframe timestamps from `ffprobe -show_entries frame=pts_time -of csv=p=0` output. */
export function parseKeyframeTimes(stdout) {
  // Lines can carry a trailing comma ("0.000000,"); blank lines must not count as t=0.
  return stdout
    .split('\n')
    .map((l) => l.trim().replace(/,+$/, ''))
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

/** Longest stretch without a keyframe, including the tail up to the clip's end. */
export function largestKeyframeGap(times, duration) {
  if (!times.length) return Number.isFinite(duration) ? duration : Infinity;
  const points = Number.isFinite(duration) && duration > times[times.length - 1] ? [...times, duration] : times;
  let max = 0;
  for (let i = 1; i < points.length; i++) max = Math.max(max, points[i] - points[i - 1]);
  return max;
}

/**
 * HyperFrames seeks into every source; footage with keyframes several seconds apart
 * (common for phone and screen recordings) freezes or shows wrong frames. Re-encode such
 * clips once with a keyframe every second; well-behaved clips are used as-is.
 * Returns the path to use for rendering.
 */
export async function ensureSeekable(srcPath, cachePath, { signal } = {}) {
  if (await exists(cachePath)) return cachePath;
  if ((await maxKeyframeInterval(srcPath)) <= 2.5) return srcPath;
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.part.mp4`;
  const res = await run('ffmpeg', [
    '-v', 'error', '-y', '-i', srcPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', '-keyint_min', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp,
  ], { signal });
  if (res.code !== 0) {
    await fs.rm(tmp, { force: true });
    return srcPath; // fall back to the original; HyperFrames will still render it
  }
  await fs.rename(tmp, cachePath);
  return cachePath;
}

/**
 * Write the HyperFrames project for one version/format into projectDir.
 * clips carry `blurPath` when a blurred background was prepared.
 */
export async function writeProject({ projectDir, plan, clips, transcripts, settings }) {
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.mkdir(path.join(projectDir, 'media'), { recursive: true });
  const used = new Set(plan.scenes.map((s) => s.clip));
  const projectClips = [];
  for (const c of clips) {
    if (!used.has(c.id)) continue;
    await linkOrCopy(c.path, path.join(projectDir, 'media', c.file));
    const extra = { blurFile: null, voiceFile: null };
    if (c.blurPath) {
      extra.blurFile = `${c.id}-blur.mp4`;
      await linkOrCopy(c.blurPath, path.join(projectDir, 'media', extra.blurFile));
    }
    if (c.voicePath) {
      extra.voiceFile = `${c.id}-voice${path.extname(c.voicePath)}`;
      await linkOrCopy(c.voicePath, path.join(projectDir, 'media', extra.voiceFile));
    }
    projectClips.push({ ...c, ...extra });
  }
  let logoFile = null;
  if (settings.logoPath) {
    logoFile = `logo${path.extname(settings.logoPath)}`;
    await linkOrCopy(settings.logoPath, path.join(projectDir, 'media', logoFile));
  }
  let narrationFile = null;
  if (settings.narration?.path) {
    narrationFile = `narration${path.extname(settings.narration.path)}`;
    await linkOrCopy(settings.narration.path, path.join(projectDir, 'media', narrationFile));
  }
  let musicFile = null;
  if (settings.musicPath) {
    musicFile = `music${path.extname(settings.musicPath)}`;
    await linkOrCopy(settings.musicPath, path.join(projectDir, 'media', musicFile));
  }
  let gsapSrc = 'gsap.min.js';
  if (await exists(GSAP_LOCAL)) await fs.copyFile(GSAP_LOCAL, path.join(projectDir, 'gsap.min.js'));
  else gsapSrc = GSAP_CDN;
  let sfxFiles = null;
  if (settings.sfxDir) {
    sfxFiles = {};
    await fs.mkdir(path.join(projectDir, 'media', 'sfx'), { recursive: true });
    for (const name of Object.keys(SFX_VOLUME)) {
      const src = path.join(settings.sfxDir, `${name}.wav`);
      if (!(await exists(src))) continue;
      await linkOrCopy(src, path.join(projectDir, 'media', 'sfx', `${name}.wav`));
      sfxFiles[name] = `sfx/${name}.wav`;
    }
  }
  const fontFiles = {};
  for (const [key, src] of Object.entries(settings.fontPaths || {})) {
    if (!src) continue;
    await fs.mkdir(path.join(projectDir, 'fonts'), { recursive: true });
    fontFiles[key] = `${key}${path.extname(src)}`;
    await linkOrCopy(src, path.join(projectDir, 'fonts', fontFiles[key]));
  }

  const result = buildComposition({ plan, clips: projectClips, transcripts, settings: { ...settings, logoFile, musicFile, fontFiles, sfxFiles, narrationFile }, gsapSrc });
  await fs.writeFile(path.join(projectDir, 'index.html'), result.html);
  // Closed-caption sidecar (sentence-sized cues) for uploading to the platform.
  const srt = toSrt(withNarration(buildCaptions(result.timeline, transcripts, 'srt'), settings.narration, result.total, 'srt'));
  return { ...result, srt };
}

/**
 * Parallel Chrome capture workers. Measured on a 4-core codespace: 1 worker 29 s, 2 workers 19 s,
 * 3 workers 18.5 s for the same 12 s clip (byte-identical output), so 2 is the sweet spot; a 2-core
 * machine keeps 1 so the encoder isn't starved. CLIPFORGE_RENDER_WORKERS overrides.
 */
export function renderWorkers(cpus = os.cpus().length) {
  const forced = Number(process.env.CLIPFORGE_RENDER_WORKERS);
  if (forced >= 1) return Math.floor(forced);
  return cpus >= 3 ? 2 : 1;
}

/**
 * Render projectDir to outputPath with `npx hyperframes render`.
 */
export async function renderProject({ projectDir, outputPath, quality = 'looks', onProgress, logPath, signal }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.rm(outputPath, { force: true });

  const renderArgs = ['render', projectDir, '--output', outputPath, '--quality', quality, '--fps', String(FPS), '--workers', String(renderWorkers())];
  const useLocal = await exists(LOCAL_HYPERFRAMES);
  const [cmd, args] = useLocal ? [LOCAL_HYPERFRAMES, renderArgs] : ['npx', ['--yes', 'hyperframes', ...renderArgs]];

  let res;
  try {
    res = await run(cmd, args, {
      cwd: ROOT,
      signal,
      // Local render only; telemetry off so nothing leaves your machine.
      env: { FORCE_COLOR: '0', NO_COLOR: '1', CI: '1', HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' },
      onLine: (line) => {
        const m = line.match(/@hf-progress\s+(\{.*\})/);
        if (!m || !onProgress) return;
        try {
          const p = JSON.parse(m[1]);
          onProgress(clamp(Number(p.pct) / 100, 0, 1), p.code);
        } catch {
          /* ignore malformed progress lines */
        }
      },
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PipelineError('HyperFrames CLI not found.', {
        hint: 'Run `npm install` in the ClipForge folder (it installs hyperframes), or `npm install -g hyperframes`.',
      });
    }
    throw err;
  }
  if (logPath) await fs.writeFile(logPath, `$ ${cmd} ${args.join(' ')}\n\n${res.stdout}\n${res.stderr}`);

  const ok = res.code === 0 && (await fs.stat(outputPath).catch(() => null))?.size > 0;
  if (!ok) {
    const detail = tail(`${res.stdout}\n${res.stderr}`, 30);
    let hint;
    if (/Chrome Headless Shell|browser ensure|Could not find Chrome/i.test(detail)) {
      hint = 'HyperFrames needs its headless Chrome: run `npx hyperframes browser ensure`.';
    } else if (/ffmpeg/i.test(detail) && /not found|ENOENT/i.test(detail)) {
      hint = 'HyperFrames needs FFmpeg on your PATH.';
    } else if (/timeout/i.test(detail)) {
      hint = 'The render timed out — try a lower resolution or the "draft" quality.';
    }
    throw new PipelineError('HyperFrames render failed.', { detail, hint });
  }
  return outputPath;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, tail, exists, linkOrCopy, round, clamp, escapeHtml, PipelineError } from './util.js';

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
export const CAPTION_STYLES = ['off', 'clean', 'bold'];
export const FRAMINGS = ['blur', 'face', 'crop', 'fit'];

// Transitions where the incoming scene overlaps the tail of the previous one.
const OVERLAP_TRANSITIONS = new Set(['crossfade', 'slide-left', 'slide-up', 'zoom', 'wipe']);
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
 * Turn Whisper word timings inside each scene's source range into caption cues on the output timeline.
 */
export function buildCaptions(timeline, transcripts, style) {
  if (style === 'off') return [];
  const maxWords = style === 'bold' ? 3 : 8;
  const maxChars = style === 'bold' ? 20 : 42;
  const cues = [];

  for (const sc of timeline.scenes) {
    const t = transcripts[sc.clip];
    if (!t) continue;
    const { srcStart, srcEnd } = sc;
    const sceneEnd = sc.tlStart + sc.duration;
    const map = (src) => sc.tlStart + (clamp(src, srcStart, srcEnd) - srcStart) / sc.speed;
    const words = (t.words?.length ? t.words : segmentsToWords(t.segments || [])).filter(
      (w) => w.end > srcStart + 0.05 && w.start < srcEnd - 0.05,
    );

    let group = [];
    const flush = () => {
      if (!group.length) return;
      const text = group.map((w) => w.word).join(' ').replace(/\s+([,.!?;:])/g, '$1');
      const start = map(group[0].start);
      const end = Math.min(Math.max(map(group[group.length - 1].end) + 0.15, start + 0.4), sceneEnd);
      cues.push({ start, end, text: style === 'bold' ? text.toUpperCase() : text });
      group = [];
    };
    for (const w of words) {
      const prev = group[group.length - 1];
      const nextLen = group.reduce((n, g) => n + g.word.length + 1, 0) + w.word.length;
      if (prev && (w.start - prev.end > 0.6 || group.length >= maxWords || nextLen > maxChars || /[.!?]$/.test(prev.word))) {
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

function segmentsToWords(segments) {
  // Fallback when Whisper gave no word timestamps: spread each segment's words evenly.
  return segments.flatMap((s) => {
    const parts = s.text.split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(parts.length, 1);
    return parts.map((word, i) => ({ word, start: s.start + i * step, end: s.start + (i + 1) * step }));
  });
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
export function buildComposition({ plan, clips, transcripts, settings, gsapSrc = 'gsap.min.js' }) {
  const { width: W, height: H } = settings;
  const u = Math.min(W, H) / 1080; // type scale relative to a 1080px short edge
  const px = (n) => `${Math.round(n * u)}px`;
  const tall = H / W; // 1.78 vertical, 1.25 feed, 1 square, 0.56 landscape
  // Platform UI safe zones (TikTok/Reels cover the bottom ~20% and the top bar on vertical video).
  const safeTop = Math.round(H * (tall > 1.5 ? 0.11 : 0.07));
  const safeBottom = Math.round(H * (tall > 1.5 ? 0.22 : tall > 1.1 ? 0.12 : 0.08));
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accent || '') ? settings.accent : '#7c5cff';
  const clipById = new Map(clips.map((c) => [c.id, c]));

  const laid = layoutTimeline(plan);
  const total = laid.total;
  // Captions step aside for CTA end cards so the call to action reads cleanly.
  const ctas = plan.overlays.filter((o) => o.type === 'cta');
  const captions = buildCaptions(laid, transcripts, settings.captions)
    .map((c) => {
      for (const o of ctas) {
        if (c.start >= o.start - 0.05 && c.start < o.end) return null;
        if (c.start < o.start && c.end > o.start) c = { ...c, end: o.start };
      }
      return c.end - c.start >= 0.15 ? c : null;
    })
    .filter(Boolean);

  const tweens = [];
  const sceneHtml = laid.scenes.map((s, i) => {
    const clip = clipById.get(s.clip);
    const id = `s${i}`;
    const dur = s.duration;
    const end = s.tlStart + dur;
    const ease = 'power2.inOut';

    // Visual entrance
    if (s.overlapIn > 0) {
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
    // Visual exit (fade to black before a fadeblack transition)
    if (s.fadeOut > 0) {
      tweens.push(
        `tl.fromTo("#${id}", { opacity: 1 }, { opacity: 0, duration: ${round(s.fadeOut, 3)}, ease: "none", immediateRender: false }, ${round(end - s.fadeOut, 3)});`,
      );
    }
    // In-scene camera move on the inner wrapper (never on the timed <video> itself)
    if (s.effect === 'kenburns') {
      tweens.push(`tl.fromTo("#${id}i", { scale: 1 }, { scale: 1.12, duration: ${round(dur, 3)}, ease: "none" }, ${s.tlStart});`);
    } else if (s.effect === 'punch-in') {
      tweens.push(`tl.fromTo("#${id}i", { scale: 1.15 }, { scale: 1.2, duration: ${round(dur, 3)}, ease: "none" }, ${s.tlStart});`);
    }

    // Audio: the clip's own sound stays on the <video>; fades ride a volume automation lane.
    const isFirst = i === 0;
    const isLast = i === laid.scenes.length - 1;
    const v = s.volume;
    let audioIn = Math.max(s.overlapIn, s.fadeIn, isFirst ? plan.audio.fadeIn : 0);
    let audioOut = Math.max(s.overlapOut, s.fadeOut, isLast ? plan.audio.fadeOut : 0);
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
    const fit = !mismatch || settings.framing === 'crop' || settings.framing === 'face' ? 'cover' : 'contain';
    let position = '50% 50%';
    let origin = '50% 50%';
    if (mismatch && settings.framing === 'face') {
      const face = faceCenter(clip.faces, s.srcStart, s.srcEnd);
      if (face) ({ position, origin } = coverPositionFor(face, clip, W, H));
    }

    const timing = `data-start="${s.tlStart}" data-duration="${round(dur, 3)}" data-media-start="${round(s.srcStart, 3)}"${
      s.speed !== 1 ? ` data-playback-rate="${s.speed}"` : ''
    }`;
    const bg = useBlur
      ? `\n      <video id="b${i}" class="bg" src="media/${escapeHtml(clip.blurFile)}" ${timing} data-track-index="${20 + (i % 2)}" muted playsinline></video>`
      : '';
    const voice = useVoice
      ? `\n      <audio id="a${i}" src="media/${escapeHtml(clip.voiceFile)}" ${timing} data-track-index="${30 + (i % 2)}" ${volumeAttrs}></audio>`
      : '';
    return `    <div id="${id}" class="scene">${bg}
      <div id="${id}i" class="inner" style="transform-origin: ${origin}">
        <video id="v${i}" src="media/${escapeHtml(clip.file)}" ${timing} data-track-index="${i % 2}" playsinline ${videoAudioAttrs} style="object-fit: ${fit}; object-position: ${position}"></video>
      </div>${voice}
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

  const captionHtml = captions.map((c, i) => {
    const id = `cap${i}`;
    if (settings.captions === 'bold') {
      tweens.push(`tl.fromTo("#${id}i", { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.12, ease: "back.out(2)" }, ${c.start});`);
    }
    return `    <div id="${id}" class="clip cap cap-${settings.captions}" data-start="${c.start}" data-duration="${round(c.end - c.start, 3)}" data-track-index="9"><span id="${id}i">${escapeHtml(c.text)}</span></div>`;
  });
  const layerHtml = (n) => overlayHtml.filter((o) => o.layer === n).map((o) => o.html);
  // Brand watermark: the logo in the top-right corner for the whole video.
  const watermark =
    settings.watermark && settings.logoFile
      ? [`    <div id="wm" class="clip wm" data-start="0" data-duration="${total}" data-track-index="40"><img src="media/${escapeHtml(settings.logoFile)}" alt="" /></div>`]
      : [];

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${W}, height=${H}" />
  <title>${escapeHtml(plan.title)}</title>
  <script src="${gsapSrc}"></script>
  <style>
    html, body { margin: 0; background: #000; }
    #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #fff; }
    .scene, .inner { position: absolute; inset: 0; }
    .scene video { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
    .scene video.bg { object-fit: cover; transform: scale(1.08); filter: brightness(0.7) saturate(1.2); }

    /* Overlay clips are full-frame boxes; HyperFrames only auto-sizes clips with no size of their own. */
    .ov, .cap { position: absolute; left: 0; top: 0; width: 100%; height: 100%; box-sizing: border-box; pointer-events: none; }
    .ov { display: flex; justify-content: center; }
    .ov-inner { max-width: 86%; text-align: center; }
    .pos-top { align-items: flex-start; padding-top: ${safeTop}px; }
    .pos-center { align-items: center; }
    .pos-bottom { align-items: flex-end; padding-bottom: ${safeBottom + Math.round(140 * u)}px; }

    .ov-hook .main { display: inline-block; background: #fff; color: #0b0b0f; font-size: ${px(tall > 1.1 ? 78 : 70)}; font-weight: 900;
      line-height: 1.08; letter-spacing: -0.02em; padding: ${px(14)} ${px(30)}; border-radius: ${px(18)}; box-shadow: 0 ${px(10)} ${px(40)} rgba(0,0,0,.35); }
    .ov-hook .sub { margin-top: ${px(14)}; font-size: ${px(40)}; font-weight: 700; text-shadow: 0 ${px(2)} ${px(12)} rgba(0,0,0,.7); }

    .ov-title .ov-inner { background: radial-gradient(ellipse at center, rgba(0,0,0,.55), rgba(0,0,0,0) 70%); padding: ${px(40)} ${px(60)}; }
    .ov-title .main { font-size: ${px(100)}; font-weight: 800; letter-spacing: -0.02em; line-height: 1.05; text-shadow: 0 ${px(4)} ${px(24)} rgba(0,0,0,.6); }
    .ov-title .sub { margin-top: ${px(18)}; font-size: ${px(40)}; font-weight: 500; opacity: .9; text-shadow: 0 ${px(2)} ${px(12)} rgba(0,0,0,.6); }

    .ov-text .main, .ov-caption .main { display: inline-block; font-size: ${px(52)}; font-weight: 700; line-height: 1.2;
      background: rgba(0,0,0,.6); padding: ${px(10)} ${px(22)}; border-radius: ${px(10)}; }
    .ov-text .sub, .ov-caption .sub { margin-top: ${px(10)}; font-size: ${px(32)}; opacity: .9; }

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

    .cap { display: flex; justify-content: center; align-items: flex-end; padding-bottom: ${safeBottom}px; }
    .cap span { display: block; max-width: 84%; text-align: center; }
    .cap-clean span { font-size: ${px(46)}; font-weight: 600; line-height: 1.25; background: rgba(0,0,0,.62); padding: ${px(8)} ${px(20)}; border-radius: ${px(8)}; }
    .cap-bold span { font-size: ${px(84)}; font-weight: 900; line-height: 1.05; letter-spacing: -0.01em; color: #fff;
      -webkit-text-stroke: ${px(4)} #000; paint-order: stroke fill; text-shadow: 0 ${px(6)} ${px(18)} rgba(0,0,0,.55); }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${total}" data-fps="${FPS}">
${[...sceneHtml, ...layerHtml(0), ...captionHtml, ...watermark, ...layerHtml(1), ...layerHtml(2)].join('\n')}
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
  const times = res.stdout.split('\n').map(Number).filter(Number.isFinite);
  const duration = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).stdout);
  if (Number.isFinite(duration)) times.push(duration);
  let max = 0;
  for (let i = 1; i < times.length; i++) max = Math.max(max, times[i] - times[i - 1]);
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
  let gsapSrc = 'gsap.min.js';
  if (await exists(GSAP_LOCAL)) await fs.copyFile(GSAP_LOCAL, path.join(projectDir, 'gsap.min.js'));
  else gsapSrc = GSAP_CDN;

  const result = buildComposition({ plan, clips: projectClips, transcripts, settings: { ...settings, logoFile }, gsapSrc });
  await fs.writeFile(path.join(projectDir, 'index.html'), result.html);
  return result;
}

/**
 * Render projectDir to outputPath with `npx hyperframes render`.
 */
export async function renderProject({ projectDir, outputPath, quality = 'looks', onProgress, logPath, signal }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.rm(outputPath, { force: true });

  const renderArgs = ['render', projectDir, '--output', outputPath, '--quality', quality, '--fps', String(FPS)];
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

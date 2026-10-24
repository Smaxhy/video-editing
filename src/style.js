import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, tail, round, PipelineError } from './util.js';
import { callClaude, extractJson } from './editor.js';
import { frameStrip } from './review.js';
import { parseSignalstats } from './picture.js';

/**
 * "Copy a style": the creator points ClipForge at reels they like (links, or videos they uploaded).
 * Each reference is measured (cut rhythm, speaking rate, colour, loudness) and Claude watches a frame
 * strip of each one, then writes a style profile: concrete renderer settings (captions, motion,
 * effects, colour look, pacing) plus an editor's guide the planner follows for every new video.
 */

const YTDLP = { x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64' };
let ytdlpPromise = null;

/** Standalone yt-dlp (Unlicense), downloaded once, for public reel/short/TikTok links. */
export function ensureYtDlp(toolsDir) {
  ytdlpPromise ||= (async () => {
    const bin = path.join(toolsDir, 'yt-dlp');
    if (fsSync.existsSync(bin)) return bin;
    const asset = process.platform === 'linux' && YTDLP[process.arch];
    if (!asset) throw new PipelineError('Downloading links is not supported on this machine — upload the videos instead.');
    const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
    if (!r.ok) throw new PipelineError(`Could not get the video downloader (HTTP ${r.status}).`);
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.writeFile(`${bin}.part`, Buffer.from(await r.arrayBuffer()));
    await fs.chmod(`${bin}.part`, 0o755);
    await fs.rename(`${bin}.part`, bin);
    return bin;
  })().catch((err) => {
    ytdlpPromise = null;
    throw err;
  });
  return ytdlpPromise;
}

/** Download one public video link into dir; returns the file path. */
export async function downloadLink(url, dir, { toolsDir, signal }) {
  const bin = await ensureYtDlp(toolsDir);
  await fs.mkdir(dir, { recursive: true });
  const r = await run(bin, [
    '--no-playlist', '--no-progress', '--restrict-filenames', '--max-filesize', '400M',
    '-f', 'bv*[ext=mp4][height<=1920]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4',
    '-o', path.join(dir, '%(title).70B-%(id)s.%(ext)s'), url,
  ], { signal, timeoutMs: 10 * 60_000 });
  const files = (await fs.readdir(dir)).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f) && !f.includes('.part'));
  if (r.code !== 0 || !files.length) {
    const why = tail(r.stderr, 3);
    const hint = /login|log in|cookies|rate-limit|private|not available|403|401/i.test(why)
      ? 'The site blocked the download (Instagram often needs a login). Save the reel to your phone and upload it to the Library instead.'
      : 'Check the link is public, or save the video and upload it to the Library instead.';
    throw new PipelineError(`Could not download ${url}`, { detail: why, hint });
  }
  return path.join(dir, files[0]);
}

/** Cut times from FFmpeg's scene score (works everywhere, no PySceneDetect needed). */
export function parseCuts(text) {
  return [...text.matchAll(/pts_time:([\d.]+)/g)].map((m) => round(Number(m[1]), 2));
}

/** Rhythm numbers from cut times. */
export function rhythm(cuts, duration) {
  const pts = [0, ...cuts.filter((c) => c > 0.2 && c < duration - 0.2), duration];
  const shots = pts.slice(1).map((t, i) => t - pts[i]).filter((d) => d > 0.05);
  const sorted = [...shots].sort((a, b) => a - b);
  return {
    shots: shots.length,
    avgShot: round(duration / Math.max(1, shots.length), 2),
    medianShot: round(sorted[Math.floor(sorted.length / 2)] || duration, 2),
    cutsPerSecond: round((shots.length - 1) / Math.max(1, duration), 2),
    firstCut: round(pts[1] || duration, 2),
  };
}

/** Measure one reference video. */
export async function measureReference(file, { transcript, signal }) {
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', file]);
  const info = JSON.parse(probe.stdout || '{}');
  const duration = Number(info.format?.duration) || 0;
  const v = (info.streams || []).find((st) => st.codec_type === 'video') || {};
  const hasAudio = (info.streams || []).some((st) => st.codec_type === 'audio');
  const scenes = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', "scale=320:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { signal, timeoutMs: 10 * 60_000 });
  const colour = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-an', '-vf', "select='not(mod(n\\,20))',scale=320:-2,format=yuv420p,signalstats,metadata=print:file=-", '-f', 'null', '-'], { signal, timeoutMs: 10 * 60_000 });
  let lufs = null;
  if (hasAudio) {
    const l = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { signal, timeoutMs: 10 * 60_000 });
    const m = [...l.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
    lufs = m.length ? Number(m[m.length - 1][1]) : null;
  }
  const words = transcript?.words || [];
  const talk = words.reduce((n, w) => n + Math.max(0, w.end - w.start), 0);
  return {
    duration: round(duration, 2),
    width: v.width,
    height: v.height,
    ...rhythm(parseCuts(scenes.stderr), duration),
    colour: parseSignalstats(colour.stdout),
    lufs,
    wordsPerMinute: duration ? Math.round((words.length / duration) * 60) : 0,
    talkShare: duration ? round(talk / duration, 2) : 0,
    transcript: words.map((w) => w.word).join(' ').slice(0, 600),
  };
}

export function buildStylePrompt(refs) {
  return `You are a senior short-form video editor. A creator wants their new videos to look, sound and FEEL like these reference videos — human, not like an automated template. Study them closely.
Open every frame strip below with the Read tool. Tiles are labelled with their time; the first four of each strip cover the hook (0.3/1/2/3 s).

${refs.map((r, i) => `## Reference ${i + 1}: ${r.name}
- frame strip: ${r.image}
- ${r.m.duration}s, ${r.m.width}x${r.m.height}; ${r.m.shots} shots, average shot ${r.m.avgShot}s (median ${r.m.medianShot}s), first cut at ${r.m.firstCut}s
- speech: ${r.m.wordsPerMinute} words/min, talking ${Math.round(r.m.talkShare * 100)}% of the time${r.m.transcript ? `; opens with: "${r.m.transcript.slice(0, 220)}"` : ' (no speech detected)'}
- loudness ${r.m.lufs ?? '?'} LUFS; average brightness ${r.m.colour?.y ?? '?'}/255, saturation ${r.m.colour?.sat ?? '?'}, U/V tint ${r.m.colour?.u ?? '?'}/${r.m.colour?.v ?? '?'} (128 = neutral; U>128 bluer, V>128 redder)`).join('\n\n')}

## What to work out (what they have in COMMON)
Captions (are there any? case, font feel, words at a time, colour of the highlighted word, box or outline, where on screen), on-screen text and titles, the hook (what happens in the first 2 s), pacing, how cuts are made (hard cuts vs transitions), camera movement and zooms, colour grade, music vs natural sound vs voiceover vs talking to camera, sound effects, how it ends, and the small human touches that make it feel real (handheld moments, natural pauses kept, imperfect framing, reactions, real sounds).

## Response
Reply with ONLY this JSON:
{"name": "2-4 word name for this style",
 "summary": "one sentence a creator would recognise",
 "captions": {"style": "bold|pop|clean|off", "case": "upper|sentence", "position": "bottom|middle", "highlight": "#rrggbb or null"},
 "motion": "off|subtle|punchy",
 "sfx": "off|subtle|full",
 "intensity": "clean|creator|max",
 "tighten": "natural|tight",
 "look": "natural|warm|cool|moody|vibrant|film",
 "music": "off|low|medium|high",
 "voiceover": "off|auto|on",
 "guide": ["8-14 short, concrete instructions for the editor to recreate this style — pacing in seconds, how to open, text rules, what to avoid"]}
Choices: bold = 2-3 word karaoke captions with an outline, pop = one big word at a time, clean = small subtitles in a box. motion: off = locked shots, subtle = only hiding jump cuts / gentle pushes, punchy = zooms on key words and beat pulses. sfx: whooshes/pops — off unless you can see heavy transitions. tighten: natural keeps breaths and pauses, tight removes every pause. intensity: clean = straight cuts, creator = a styled transition (punch-in cut, whip, zoom, flash, light leak) every few seconds, max = styled cuts on most beats with shakes and speed ramps.`;
}

const pick = (v, list, d) => (list.includes(v) ? v : d);

/** Validate Claude's profile and add the measured numbers. Exported for tests. */
export function normalizeProfile(raw, measures) {
  const c = raw?.captions || {};
  const avg = measures.length ? round(measures.reduce((n, m) => n + m.avgShot, 0) / measures.length, 2) : null;
  const wpm = measures.length ? Math.round(measures.reduce((n, m) => n + m.wordsPerMinute, 0) / measures.length) : 0;
  const talk = measures.length ? round(measures.reduce((n, m) => n + m.talkShare, 0) / measures.length, 2) : 0;
  return {
    name: String(raw?.name || 'My style').replace(/\s+/g, ' ').trim().slice(0, 40),
    summary: String(raw?.summary || '').slice(0, 300),
    captions: {
      style: pick(c.style, ['bold', 'pop', 'clean', 'off'], 'bold'),
      case: pick(c.case, ['upper', 'sentence'], 'upper'),
      position: pick(c.position, ['bottom', 'middle'], 'bottom'),
      highlight: /^#[0-9a-f]{6}$/i.test(c.highlight || '') ? c.highlight : null,
    },
    motion: pick(raw?.motion, ['off', 'subtle', 'punchy'], 'subtle'),
    sfx: pick(raw?.sfx, ['off', 'subtle', 'full'], 'subtle'),
    intensity: pick(raw?.intensity, ['clean', 'creator', 'max'], 'creator'),
    tighten: pick(raw?.tighten, ['natural', 'tight'], 'natural'),
    look: pick(raw?.look, ['natural', 'warm', 'cool', 'moody', 'vibrant', 'film'], 'natural'),
    music: pick(raw?.music, ['off', 'low', 'medium', 'high'], 'medium'),
    voiceover: pick(raw?.voiceover, ['off', 'auto', 'on'], 'auto'),
    guide: (Array.isArray(raw?.guide) ? raw.guide : []).map((g) => String(g).slice(0, 240)).filter(Boolean).slice(0, 16),
    measured: { avgShot: avg, wordsPerMinute: wpm, talkShare: talk },
  };
}

/** The planner's instructions for a profile. */
export function styleGuideText(p) {
  const m = p.measured || {};
  return [
    `Style "${p.name}": ${p.summary}`,
    m.avgShot ? `- Rhythm measured from the references: average shot ${m.avgShot}s — cut at about that pace (vary it a little; never mechanical).` : null,
    m.talkShare != null ? `- In the references people talk ${Math.round((m.talkShare || 0) * 100)}% of the time${m.wordsPerMinute ? ` at ~${m.wordsPerMinute} words/min` : ''}.` : null,
    ...p.guide.map((g) => `- ${g}`),
  ].filter(Boolean).join('\n');
}

export function createStyles({ dir, library, toolsDir, transcribeAsset, onChange = () => {} }) {
  const file = path.join(dir, 'styles.json');
  let styles = [];
  try {
    styles = JSON.parse(fsSync.readFileSync(file, 'utf8'));
  } catch {
    /* none yet */
  }
  // A restart interrupts analysis — mark it so the user can retry.
  for (const s of styles) if (s.status === 'analyzing') Object.assign(s, { status: 'error', error: { message: 'Interrupted by a restart — try again.' } });
  const save = async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(styles, null, 2));
    await fs.rename(`${file}.tmp`, file);
  };
  const pub = (s) => ({ id: s.id, name: s.profile?.name || s.name, status: s.status, message: s.message || '', error: s.error || null, warnings: s.warnings || [], createdAt: s.createdAt, refs: s.refs.length, profile: s.profile || null });
  const changed = () => onChange({ type: 'styles', styles: styles.map(pub) });
  const say = (s, message) => {
    s.message = message;
    changed();
  };

  async function analyze(s, { urls, assetIds }) {
    const work = path.join(dir, s.id);
    await fs.mkdir(work, { recursive: true });
    try {
      // 1. Links → library videos (flagged as style references so they're never used as footage).
      // A blocked link (Instagram often needs a login) doesn't stop the rest.
      s.warnings = [];
      let lastErr = null;
      for (const [i, url] of urls.entries()) {
        say(s, `Downloading reference ${i + 1}/${urls.length}…`);
        try {
          const f = await downloadLink(url, path.join(work, `dl${i}`), { toolsDir });
          const a = await library.ingest(f, { name: path.basename(f), size: (await fs.stat(f)).size, source: { type: 'link', url } });
          assetIds.push(a.id);
        } catch (err) {
          lastErr = err;
          s.warnings.push(`${url}: ${err.hint || err.message}`);
        }
      }
      if (!assetIds.length) throw lastErr || new PipelineError('No reference videos.');
      for (const id of assetIds) await library.setFields(id, { styleRef: true });
      s.refs = assetIds;
      await save();
      // 2. Measure + frame strip per reference.
      const refs = [];
      for (const [i, id] of assetIds.entries()) {
        const a = library.get(id);
        if (!a) continue;
        say(s, `Studying reference ${i + 1}/${assetIds.length}: cuts, captions, colour, sound…`);
        const src = library.sourcePath(id);
        const transcript = a.hasAudio ? await transcribeAsset(a).catch(() => null) : null;
        const m = await measureReference(src, { transcript });
        const times = [0.3, 1, 2, 3];
        for (let t = 4.5; t < m.duration - 0.2 && times.length < 18; t += Math.max(1.5, (m.duration - 4) / 14)) times.push(round(t, 2));
        const image = `ref${i + 1}.jpg`;
        await frameStrip(src, path.join(work, image), times.filter((t) => t < m.duration), { width: a.width || 1080, height: a.height || 1920 });
        refs.push({ name: a.name, image, m });
      }
      if (!refs.length) throw new PipelineError('None of the reference videos could be read.');
      // 3. Claude watches them and writes the profile.
      say(s, `Claude is studying the style of ${refs.length} video${refs.length > 1 ? 's' : ''}…`);
      const raw = extractJson(await callClaude(buildStylePrompt(refs), { cwd: work, tools: 'Read' }));
      s.profile = normalizeProfile(raw, refs.map((r) => r.m));
      if (s.name) s.profile.name = s.name;
      s.status = 'ready';
      s.message = '';
    } catch (err) {
      s.status = 'error';
      s.error = { message: err.message, hint: err.hint || null };
      console.error('[style]', err.message, err.detail || '');
    } finally {
      await save();
      changed();
    }
  }

  return {
    list: () => styles.map(pub),
    get: (id) => styles.find((s) => s.id === id && s.status === 'ready')?.profile || null,
    create({ name, urls = [], assetIds = [] }) {
      const cleanUrls = [...new Set(urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\/\S+$/i.test(u)))].slice(0, 6);
      const ids = [...new Set(assetIds)].filter((id) => library.get(id)?.kind === 'video').slice(0, 6);
      if (!cleanUrls.length && !ids.length) throw new PipelineError('Paste at least one link, or pick videos from your library.');
      const s = { id: crypto.randomUUID().slice(0, 8), name: String(name || '').trim().slice(0, 40), createdAt: Date.now(), status: 'analyzing', message: 'Starting…', refs: [], profile: null };
      styles.unshift(s);
      save().then(changed);
      analyze(s, { urls: cleanUrls, assetIds: ids });
      return pub(s);
    },
    async remove(id) {
      const s = styles.find((x) => x.id === id);
      if (!s) return false;
      if (s.status === 'analyzing') throw new PipelineError('Wait until the analysis finishes.');
      styles = styles.filter((x) => x !== s);
      await fs.rm(path.join(dir, id), { recursive: true, force: true });
      await save();
      changed();
      return true;
    },
    busy: () => styles.some((s) => s.status === 'analyzing'),
  };
}

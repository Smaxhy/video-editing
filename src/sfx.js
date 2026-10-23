import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { run, round } from './util.js';

/**
 * Transition & text sound effects, synthesised with FFmpeg — no sample packs, no licences to track.
 *   whoosh — swelling filtered noise (non-cut transitions)
 *   pop    — fast pitch-drop blip (hooks, emoji)
 *   impact — sub "boom" + noise burst (title cards)
 *   riser  — rising tone + noise (build-up into the call to action)
 *   tick   — tiny click (text / lower-third entrances)
 */
const SOUNDS = {
  whoosh: {
    d: 0.7,
    graph: '[0]highpass=f=500,lowpass=f=2200,volume=\'sin(PI*t/0.7)^3\':eval=frame[a];[1]highpass=f=2500,lowpass=f=7000,volume=\'sin(PI*min(t,0.7)/0.7)^6*0.8\':eval=frame[b];[a][b]amix=inputs=2:normalize=0',
    inputs: ["aevalsrc='random(0)*2-1':s=48000:d=0.7", "aevalsrc='random(1)*2-1':s=48000:d=0.7"],
  },
  pop: { d: 0.14, inputs: ["aevalsrc='0.9*sin(2*PI*t*(1500-5200*t))*exp(-t*32)':s=48000:d=0.14"] },
  impact: {
    d: 1.1,
    inputs: ["aevalsrc='0.95*sin(2*PI*t*(48+60*exp(-t*9)))*exp(-t*3.6)+0.45*(random(0)*2-1)*exp(-t*22)':s=48000:d=1.1"],
    graph: '[0]lowpass=f=3500',
  },
  riser: {
    d: 1.5,
    inputs: ["aevalsrc='0.55*(t/1.5)^2*sin(2*PI*t*(180+520*t))+0.3*(t/1.5)^3*(random(0)*2-1)':s=48000:d=1.5"],
    graph: '[0]highpass=f=150,afade=t=out:st=1.42:d=0.08',
  },
  tick: { d: 0.06, inputs: ["aevalsrc='0.7*sin(2*PI*2600*t)*exp(-t*95)':s=48000:d=0.06"] },
};
export const SFX_VOLUME = { whoosh: 0.5, pop: 0.45, impact: 0.55, riser: 0.45, tick: 0.35 };
const VERSION = 'v1';

let pending = null;

/** Folder with every effect as a 48 kHz WAV (generated once). */
export function ensureSfx(toolsDir) {
  pending ||= (async () => {
    const dir = path.join(toolsDir, `sfx-${VERSION}`);
    await fs.mkdir(dir, { recursive: true });
    for (const [name, s] of Object.entries(SOUNDS)) {
      const out = path.join(dir, `${name}.wav`);
      if (fsSync.existsSync(out)) continue;
      const args = ['-v', 'error', '-y'];
      for (const i of s.inputs) args.push('-f', 'lavfi', '-i', i);
      const graph = `${s.graph || '[0]anull'},alimiter=limit=0.9,aformat=sample_rates=48000:channel_layouts=stereo`;
      args.push('-filter_complex', graph, '-t', String(s.d), `${out}.part.wav`);
      const r = await run('ffmpeg', args, { timeoutMs: 60_000 });
      if (r.code !== 0) {
        pending = null;
        throw new Error(`could not synthesise ${name}: ${r.stderr.slice(-300)}`);
      }
      await fs.rename(`${out}.part.wav`, out);
    }
    return dir;
  })();
  return pending;
}

/**
 * Where effects go on the output timeline: [{ name, start }]. Rules: whoosh into every non-cut
 * transition, impact on title cards, pop on hooks and emoji, tick on text/lower-thirds, riser into the
 * CTA. At least 0.35 s between effects so it never turns into noise.
 */
export function sfxCues({ timeline, overlays, emojiTimes = [], level = 'full' }) {
  const cues = [];
  for (const s of timeline.scenes) {
    if (s.index > 0 && s.transition !== 'cut') cues.push({ name: 'whoosh', start: s.tlStart - 0.3, prio: 2 });
  }
  for (const o of overlays) {
    if (o.type === 'hook') cues.push({ name: 'pop', start: o.start, prio: 3 });
    else if (o.type === 'title') cues.push({ name: 'impact', start: o.start, prio: 3 });
    else if (o.type === 'cta') {
      cues.push({ name: 'riser', start: o.start - 1.45, prio: 3 });
      cues.push({ name: 'pop', start: o.start, prio: 3 });
    } else cues.push({ name: 'tick', start: o.start, prio: 1 });
  }
  for (const t of emojiTimes) cues.push({ name: 'pop', start: t, prio: 1 });
  // "subtle" (the default) keeps only what a human editor would add: whooshes on real transitions,
  // the hook pop and the build into the CTA — no ticks or pops on every caption.
  const keep = level === 'subtle' ? (c) => c.prio >= 2 && c.name !== 'impact' : () => true;
  const out = [];
  for (const c of cues.filter((x) => x.start >= 0 && keep(x)).sort((a, b) => b.prio - a.prio || a.start - b.start)) {
    // Risers overlap what comes after them by design; everything else keeps its distance.
    if (out.some((o) => Math.abs(o.start - c.start) < 0.35 && o.name !== 'riser' && c.name !== 'riser')) continue;
    out.push({ name: c.name, start: round(c.start, 3) });
  }
  return out.sort((a, b) => a.start - b.start);
}

export const SFX_LENGTH = Object.fromEntries(Object.entries(SOUNDS).map(([k, v]) => [k, v.d]));

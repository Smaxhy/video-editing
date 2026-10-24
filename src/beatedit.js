import { round } from './util.js';

/**
 * The music edit: ClipForge cuts the video TO the song, like an editor making a "velocity" / beat edit.
 * Claude's scenes give the moments (which part of which clip, in story order); this engine decides the
 * rhythm from the song's beat grid and its drop:
 *   intro      calmer shots of 2-4 beats, every cut on a beat
 *   build      the last bar before the drop: 1-beat (or half-beat) shots
 *   DROP       a hero shot in slow motion (the peak moment) with a flash + camera shake
 *   after      1-2 beat shots, alternating, with punch-ins on repeated moments
 *   ending     the last shot holds ~4 beats
 * Long moments are cut into several shots (a jump cut with a punch-in); short ones are stretched to
 * the beat when the clip has room. Every cut lands exactly on a beat.
 */

/** Median beat period in seconds. Exported for tests. */
export function beatPeriod(beats) {
  const d = beats.slice(1).map((b, i) => b - beats[i]).filter((x) => x > 0.2 && x < 2).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 0.5;
}

/** Shot length (in beats) for the moment `t` of the edit. */
function slotBeats(t, { drop, b, total, energy }) {
  const fastBeats = b < 0.42 ? 2 : 1; // at 140+ BPM a single beat is too short to read
  const bar = 4 * b;
  if (drop != null && t >= drop - bar && t < drop - 0.05) return 1; // the build
  if (t >= total - bar * 1.1) return 4; // hold the ending
  if (drop == null || t < drop) return energy === 'low' ? 4 : 2; // intro
  return energy === 'low' ? 2 : [fastBeats, 2 * fastBeats][Math.floor((t - drop) / bar) % 2]; // after the drop
}

/**
 * Rebuild a plan's scenes on the beat grid. `beats` / `downbeats` / `drop` are OUTPUT seconds.
 * Returns { plan, shots } (shots = 0 when the plan isn't suited: talking, no beats).
 */
export function beatEdit(plan, { beats, drop = null, talking, clipDuration, energy = 'medium', total = null }) {
  if (!beats?.length || beats.length < 8) return { plan, shots: 0 };
  const moments = plan.scenes.filter((s) => !talking(s) && s.end - s.start >= 0.3);
  if (moments.length < 2 || moments.length < plan.scenes.length * 0.7) return { plan, shots: 0 };
  const b = beatPeriod(beats);
  const target = total ?? plan.scenes.reduce((n, s) => n + (s.end - s.start) / s.speed, 0);
  const peakIdx = Math.max(0, moments.findIndex((s) => s.peak));
  const hero = moments[peakIdx];
  const nextBeat = (t) => beats.find((x) => x >= t - 0.02) ?? t;
  const cursor = new Map(moments.map((m, i) => [i, m.start])); // how far into each moment we are
  const scenes = [];
  let t = 0;
  let mi = 0;
  let heroDone = drop == null;
  let guard = 0;
  while (t < target - 0.25 && guard++ < 400) {
    // The drop: the hero moment in slow motion, with a flash and a shake.
    if (!heroDone && t >= drop - 0.05) {
      heroDone = true;
      const out = nextBeat(t + (b < 0.42 ? 8 : 4) * b) - t;
      const speed = 0.5;
      const start = hero.start;
      const end = Math.min(clipDuration(hero.clip), start + out * speed);
      if (end - start > 0.3) {
        scenes.push({ ...hero, start: round(start, 3), end: round(end, 3), speed, transition: 'flash', transitionDuration: 0, effect: 'shake', peak: true, beat: true });
        t += (end - start) / speed;
        cursor.set(peakIdx, end);
        mi = (peakIdx + 1) % moments.length;
        continue;
      }
    }
    const beatsHere = slotBeats(t, { drop, b, total: target, energy });
    let cut = nextBeat(t + beatsHere * b);
    // Never cut through the drop: the shot before it ends on it.
    if (!heroDone && drop != null && cut > drop + 0.02 && t < drop - 0.05) cut = drop;
    if (cut - t < 0.3) cut = nextBeat(t + 0.35);
    const out = Math.min(cut, target) - t;
    if (out < 0.25) break;
    // Find a moment with enough footage left (skipping the hero before the drop).
    let m = null;
    for (let k = 0; k < moments.length; k++) {
      const i = (mi + k) % moments.length;
      if (!heroDone && i === peakIdx && moments.length > 2) continue;
      const left = moments[i].end - cursor.get(i);
      if (left >= out * moments[i].speed * 0.6) {
        m = i;
        break;
      }
    }
    if (m == null) {
      // Everything used once: start over from each moment's beginning (a second pass of the best bits).
      for (const [i, mm] of moments.entries()) cursor.set(i, mm.start + Math.min(0.4, (mm.end - mm.start) / 4));
      m = mi % moments.length;
    }
    const mom = moments[m];
    const speed = mom.speed > 1.2 ? mom.speed : 1; // keep Claude's speed-ups; slow motion is for the drop
    const start = cursor.get(m);
    const end = Math.min(clipDuration(mom.clip), start + out * speed);
    if (end - start < 0.2) {
      mi = (m + 1) % moments.length;
      continue;
    }
    const prev = scenes[scenes.length - 1];
    const jump = prev && prev.clip === mom.clip && Math.abs(prev.end - start) < 0.05;
    scenes.push({
      ...mom,
      start: round(start, 3),
      end: round(end, 3),
      speed,
      transition: scenes.length === 0 ? mom.transition : 'cut',
      transitionDuration: 0,
      effect: mom.effect === 'kenburns' && (end - start) / speed > 2.5 ? 'kenburns' : 'none',
      peak: false,
      beat: true,
      ...(jump ? { jump: true } : {}),
    });
    t += (end - start) / speed;
    cursor.set(m, end);
    // Long moments give several shots in a row (with jump punch-ins); short ones move on.
    if (moments[m].end - end < b * speed || (t >= (drop ?? Infinity) && scenes.length % 2 === 0)) mi = (m + 1) % moments.length;
  }
  if (scenes.length < 3) return { plan, shots: 0 };
  return { plan: { ...plan, scenes }, shots: scenes.length };
}

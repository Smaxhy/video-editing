import { CUT_LIKE } from './editor.js';
import { round } from './util.js';

/**
 * Styling pass after beat sync, for the "creator" and "max" intensities. When Claude left a montage as
 * plain cuts, B-roll cuts that land on a downbeat get styled transitions that fit the energy (calm →
 * light leaks, hype → punch / whip / flash / glitch). Cuts stay on the beat: a blended transition
 * extends the outgoing shot instead of pulling the next one earlier. The peak (the drop) gets its
 * moment: a flash + camera shake, or a punch on calm edits. Talking cuts only ever get a "punch".
 */
const SETS = {
  low: ['light-leak', 'punch', 'crossfade', 'punch'],
  medium: ['punch', 'whip', 'zoom-through', 'punch', 'light-leak'],
  high: ['punch', 'whip', 'flash', 'zoom-through', 'glitch', 'punch', 'whip'],
};
const BLEND = { whip: 0.24, 'zoom-through': 0.32, spin: 0.34, 'light-leak': 0.6, crossfade: 0.4 };

export function spicePlan(plan, { intensity = 'creator', energy = 'medium', downbeats = [], talking, clipDuration, layout }) {
  if (intensity === 'clean' || plan.scenes.length < 2) return { plan, added: 0 };
  const scenes = plan.scenes.map((s) => ({ ...s }));
  const lay = layout({ ...plan, scenes });
  const max = intensity === 'max';
  // Spacing between styled transitions, and how many a video of this length should have in total.
  const minGap = max ? 1.2 : 3;
  const already = scenes.filter((s, i) => i > 0 && s.transition !== 'cut').length;
  const want = max ? Infinity : Math.max(0, Math.round(lay.total / 6) - already);
  const set = SETS[energy] || SETS.medium;
  const onBeat = (at) => !downbeats.length || downbeats.some((b) => Math.abs(b - at) < 0.09);
  let lastAt = -Infinity;
  let added = 0;
  let k = 0;
  for (let i = 1; i < scenes.length; i++) {
    const s = scenes[i];
    const prev = scenes[i - 1];
    const at = lay.scenes[i].tlStart;
    if (s.transition !== 'cut') {
      lastAt = at;
      continue;
    }
    if (added >= want || s.jump || at - lastAt < minGap) continue;
    const talk = talking(s) || talking(prev);
    if (talk) {
      // Between sentences of a talking video: a punch-in cut, every ~5 s at most.
      if (at - lastAt < 5 || prev.clip === s.clip) continue;
      s.transition = 'punch';
    } else {
      if (!onBeat(at)) continue;
      let t = set[k++ % set.length];
      if (!CUT_LIKE.has(t)) {
        const d = BLEND[t];
        const room = clipDuration(prev.clip) - prev.end;
        if (room >= d * prev.speed && (prev.end - prev.start) / prev.speed > d * 2.2 && (s.end - s.start) / s.speed > d * 2.2) {
          prev.end = round(prev.end + d * prev.speed, 3);
          s.transitionDuration = d;
        } else {
          t = 'punch';
        }
      }
      s.transition = t;
    }
    added++;
    lastAt = at;
  }
  // The peak: hit it.
  const p = scenes.findIndex((s) => s.peak);
  if (p > 0 && scenes[p].transition === 'cut') {
    scenes[p].transition = energy === 'low' ? 'punch' : 'flash';
    added++;
  }
  if (p >= 0 && energy !== 'low' && scenes[p].effect === 'none' && !talking(scenes[p])) scenes[p].effect = 'shake';
  return { plan: { ...plan, scenes }, added };
}

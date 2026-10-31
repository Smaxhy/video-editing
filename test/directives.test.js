import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directivesFromText, normalizeAuto, removeSlowMo, resolveAuto } from '../src/directives.js';
import { buildPrompt, normalizeSettingChanges } from '../src/editor.js';

const off = (text) => Object.keys(directivesFromText(text).off).sort();

test('directives: explicit words switch the automatic passes off', () => {
  assert.deepEqual(off('no slow motion please'), ['beatEdit', 'slowmo']);
  assert.deepEqual(off("don't use slowmo"), ['beatEdit', 'slowmo']);
  assert.deepEqual(off('stop adding so many transitions and zooms'), ['styling']);
  assert.deepEqual(off('keep it simple, just clean cuts'), ['beatEdit', 'finish', 'styling']);
  assert.deepEqual(off('put the clips in this order: beach, then sunset'), ['beatEdit']);
  assert.deepEqual(off('2 seconds each, cut to the music'), ['beatEdit', 'beatSnap']);
  assert.deepEqual(off("don't cut the clips, use the whole clip"), ['beatEdit']);
  assert.deepEqual(off('too many cuts, let the shots breathe'), ['beatEdit', 'styling']);
  assert.deepEqual(off('no grain'), ['finish']);
  assert.deepEqual(off('plain text only'), ['finish']);
  // Ordinary briefs leave everything on.
  assert.deepEqual(off('make a hype gym montage with my phonk song, add a hook'), []);
  assert.deepEqual(off('cinematic travel edit of Bali, put text "Bali 2026" at the start'), []);
  assert.deepEqual(off('fast cuts, lots of effects and transitions'), []);
  assert.ok(directivesFromText('no slow-mo').noSlowmo);
  assert.ok(!directivesFromText('fewer transitions').noSlowmo);
});

test('directives: Claude decides, the request’s words always win', () => {
  assert.deepEqual(normalizeAuto(null), { beatEdit: true, beatSnap: true, styling: true, slowmo: true, finish: true });
  assert.equal(normalizeAuto({ beatEdit: 'no' }).beatEdit, true);
  assert.equal(normalizeAuto({}, { styling: false }).styling, false); // a revision keeps last time's call

  const r = resolveAuto({ beatEdit: false }, 'no slow motion');
  assert.equal(r.auto.beatEdit, false);
  assert.equal(r.auto.slowmo, false);
  assert.equal(r.auto.styling, true);
  assert.ok(r.noSlowmo);
  assert.deepEqual(r.skipped.map((s) => s.pass).sort(), ['beatEdit', 'slowmo']);
  assert.ok(resolveAuto({ beatEdit: true }, 'hype edit').auto.beatEdit);
});

test('directives: "no slow motion" plays every scene at normal speed', () => {
  const plan = { scenes: [{ clip: 'c1', start: 2, end: 4, speed: 0.5 }, { clip: 'c2', start: 0, end: 3, speed: 1.5 }] };
  const r = removeSlowMo(plan, () => 10);
  assert.equal(r.changed, 1);
  assert.deepEqual(r.plan.scenes[0], { clip: 'c1', start: 2, end: 6, speed: 1 });
  assert.equal(r.plan.scenes[1].speed, 1.5);
  // Not past the end of the clip.
  assert.equal(removeSlowMo(plan, () => 5).plan.scenes[0].end, 5);
});

test('planner prompt: explains the automatic passes; revision shows what they did', () => {
  const clips = [{ id: 'clip1', name: 'a.mp4', duration: 10, width: 1080, height: 1920, hasAudio: true, transcript: { words: [], text: '' } }];
  const options = { goal: 'social', versions: ['30'], formats: ['9x16'], captions: 'bold', intensity: 'creator', clipAudio: 'auto' };
  const p = buildPrompt({ clips, userPrompt: 'keep the order', options });
  assert.match(p, /After your plan — ClipForge's automatic passes/);
  assert.match(p, /- "beatEdit": Re-cut the whole video/);
  assert.match(p, /"auto": \{/);
  const rev = buildPrompt({ clips, userPrompt: 'x', options: { ...options, revision: { remarks: 'too much slow motion', previous: '{}', current: {}, applied: ['slowmo: speed-ramped into 2 slow-motion scenes'], auto: { slowmo: true } } } });
  assert.match(rev, /changed the video the user watched:\n- slowmo: speed-ramped/);
  assert.match(rev, /Automatic passes last time: \{"slowmo":true\}/);
  assert.deepEqual(normalizeSettingChanges({ beatSync: false }), { beatSync: false });
});

test('settings from the user’s words: music, voiceover, sound effects, captions — latest wins', async () => {
  const { settingsFromText, asksForVoiceover } = await import('../src/directives.js');
  const p = (t) => settingsFromText(t).patch;
  for (const t of ['use the music in the background', 'I told you multiple times to add music', 'there is no music', 'still no music in the video', 'cant hear the music', 'put my song under it']) {
    assert.equal(p(t).music, 'auto', t);
    assert.equal(p(t).trendingSound, false, t);
  }
  for (const t of ['no music please', 'remove the music', 'no music, just the original sound']) assert.equal(p(t).music, 'off', t);
  assert.equal(p(['no music', 'actually add music back']).music, 'auto');
  assert.equal(p(['add music', 'remove the music']).music, 'off');
  assert.equal(p('cant hear the music').musicLevel, 'high');
  assert.equal(p('the music is too loud').musicLevel, 'low');
  assert.equal(p('the voice over is doing very bad').voiceover, 'off');
  assert.equal(p('no voiceover').voiceover, 'off');
  assert.equal(p('add a voiceover that tells the story').voiceover, 'on');
  assert.equal(p('it uses random sounds which dont fit').sfx, 'off');
  assert.equal(p('no sound effects').sfx, 'off');
  assert.equal(p('no captions').captions, 'off');
  assert.deepEqual(p('make a hype edit of my gym clips with a hook'), {});
  assert.ok(asksForVoiceover('add a voiceover'));
  assert.ok(!asksForVoiceover('make a cinematic travel video'));
  assert.ok(!asksForVoiceover('no voiceover'));
});

test('planner prompt ends with the request and every fix; earlier fixes still apply', () => {
  const clips = [{ id: 'clip1', name: 'a.mp4', duration: 10, width: 1080, height: 1920, hasAudio: true, transcript: { words: [], text: '' } }];
  const options = { goal: 'social', versions: ['30'], formats: ['9x16'], captions: 'bold', intensity: 'creator', clipAudio: 'auto' };
  const p = buildPrompt({ clips, userPrompt: 'Personal video of my weekend, calm vibe', options: { ...options, revision: { remarks: 'make it shorter', earlier: ['use the music in the background'], previous: '{}', current: {} } } });
  assert.match(p, /Earlier fixes the user asked for — they STILL apply[\s\S]*1\. """use the music in the background"""/);
  const tail = p.slice(p.indexOf('## Final check'));
  assert.match(tail, /Personal video of my weekend, calm vibe/);
  assert.match(tail, /- use the music in the background\n- make it shorter/);
  assert.ok(tail.indexOf('## Final check') < tail.indexOf('## Response format'));
  assert.deepEqual(normalizeSettingChanges({ music: 'auto' }), { music: 'auto' });
});

test('"no text" / "stupid written text" removes on-screen text; "add a title" brings it back', async () => {
  const { settingsFromText } = await import('../src/directives.js');
  const p = (t) => settingsFromText(t).patch;
  for (const t of ['it also has a STUPID WRITTEN TEXT', 'no text please', 'remove the text', "don't add titles"]) assert.equal(p(t).overlays, 'off', t);
  assert.equal(p('add a hook at the start').overlays, 'on');
  assert.equal(p(['no text', 'put a title saying Dead aspen removal']).overlays, 'on');
  assert.deepEqual(p('the subtitles overlap'), {});
});

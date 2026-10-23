// End-to-end smoke test for the Docker image (run by CI inside the container):
// tool detection → transcription → footage analysis → HyperFrames render → compression.
// Usage: clipforge-entrypoint node deploy/smoke.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, probe } from '../src/util.js';
import { detectTools } from '../src/tools.js';
import { transcribe } from '../src/transcriber.js';
import { analyzeClip } from '../src/analysis.js';
import { writeProject, renderProject } from '../src/renderer.js';
import { compressVideo } from '../src/compress.js';
import { polishAudio, ensureDeepFilter } from '../src/audio.js';
import { preparePicture } from '../src/picture.js';
import { measureQuality } from '../src/quality.js';
import { ensureYunet } from '../src/reframe.js';
import { ensureFonts } from '../src/fonts.js';
import { ensureSfx } from '../src/sfx.js';
import { scanMusic } from '../src/musicscan.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipforge-smoke-'));
const step = (name) => console.log(`\n== ${name}`);
const fail = (msg) => {
  console.error(`SMOKE TEST FAILED: ${msg}`);
  process.exit(1);
};

step('tools');
const tools = await detectTools({ fresh: true });
console.log(tools);
for (const required of ['fasterWhisper', 'sceneDetect', 'faces', 'ffmpegNormalize']) {
  if (!tools[required]) fail(`${required} missing from the image`);
}

step('test clip');
const clipPath = path.join(dir, 'clip1.mp4');
const gen = await run('ffmpeg', [
  '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipPath,
]);
if (gen.code !== 0) fail(`ffmpeg: ${gen.stderr}`);
const meta = await probe(clipPath);
console.log(meta);

if (process.env.SMOKE_SKIP_TRANSCRIBE !== '1') {
  step('transcribe (tiny model)');
  const t = await transcribe(clipPath, { model: 'tiny', engine: 'auto', tools, outDir: path.join(dir, 'tx') });
  console.log({ engine: t.engine, segments: t.segments.length, note: t.note });
}

step('analyze');
const a = await analyzeClip(
  { id: 'clip1', name: 'clip1.mp4', path: clipPath, hasAudio: true },
  { cacheFile: path.join(dir, 'analysis.json'), features: { silence: true, shots: true, faces: true, track: true, yunet: await ensureYunet(path.join(dir, 'tools')) }, tools },
);
console.log({ silences: a.silences, shots: a.shots, faces: a.faces?.length, track: a.track?.length, notes: a.notes });
if (a.notes.length) fail(`analysis errors: ${a.notes.join('; ')}`);
if (!a.track?.length) fail('subject tracking returned nothing');

step('studio sound + picture polish + quality');
const deepFilter = await ensureDeepFilter(path.join(dir, 'tools'));
const voice = await polishAudio(clipPath, path.join(dir, 'voice.m4a'), { start: 0, end: 3.5, speech: true, deepFilter }).catch((err) => fail(`studio sound: ${err.message}\n${err.detail || ''}`));
const pic = await preparePicture(clipPath, path.join(dir, 'pic.mp4'), { start: 0, end: 3.5, look: 'warm' }).catch((err) => fail(`picture polish: ${err.message}\n${err.detail || ''}`));
const q = await measureQuality(clipPath, { hasAudio: true, work: path.join(dir, 'q') });
console.log({ deepFilter: Boolean(deepFilter), voice, picture: pic.applied, quality: q.score });

step('render 9:16 with captions + overlays');
const plan = {
  title: 'Smoke',
  scenes: [{ clip: 'clip1', start: 0, end: 3, transition: 'cut', transitionDuration: 0, speed: 1, volume: 1, effect: 'punch-in' }],
  overlays: [{ type: 'hook', text: 'Smoke test', subtext: '', start: 0, end: 1.5, position: 'top' }],
  audio: { fadeIn: 0, fadeOut: 0.3 },
};
const projectDir = path.join(dir, 'project');
await writeProject({
  projectDir,
  plan,
  clips: [{ id: 'clip1', file: 'clip1.mp4', path: pic.path, videoOffset: pic.offset, voicePath: voice, voiceOffset: 0, hasAudio: true, width: 1280, height: 720, track: a.track }],
  transcripts: { clip1: { words: [{ word: 'hello', start: 0.2, end: 0.6 }] } },
  settings: {
    width: 1080, height: 1920, captions: 'bold', framing: 'smart', accent: '#7c5cff', motion: 'subtle',
    fontPaths: await ensureFonts(path.join(dir, 'tools')), sfxDir: await ensureSfx(path.join(dir, 'tools')), sfxLevel: 'subtle',
  },
});
const raw = path.join(dir, 'raw.mp4');
await renderProject({ projectDir, outputPath: raw, quality: 'draft', logPath: path.join(dir, 'render.log') }).catch(async (err) => {
  console.error(await fs.readFile(path.join(dir, 'render.log'), 'utf8').catch(() => ''));
  fail(`render: ${err.message}\n${err.detail || ''}`);
});

step('compress');
const out = path.join(dir, 'out.mp4');
const size = await compressVideo(raw, out, 'small', { twoPass: tools.ffmpegNormalize });
const outMeta = await probe(out);
console.log({ size, ...outMeta });
if (outMeta.width !== 1080 || outMeta.height !== 1920) fail('wrong output size');
if (Math.abs(outMeta.duration - 3) > 0.2) fail(`wrong duration ${outMeta.duration}`);

step('music scan (tempo, energy, drop)');
const song = path.join(dir, 'song.mp3');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,10),0.05,0.6)*sin(2*PI*55*t)*exp(-20*mod(t,0.5))':s=44100:d=30", song]);
const heard = await scanMusic(song);
console.log(heard);
if (!heard || Math.abs(heard.bpm - 120) > 3 || heard.drop == null || Math.abs(heard.drop - 10) > 1.5) fail('music scan');

console.log('\nSMOKE TEST PASSED');

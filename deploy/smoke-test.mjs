// End-to-end smoke test for the Docker image (run by CI inside the container):
// tool detection → transcription → footage analysis → HyperFrames render → compression.
// Usage: clipforge-entrypoint node deploy/smoke-test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, probe } from '../src/util.js';
import { detectTools } from '../src/tools.js';
import { transcribe } from '../src/transcriber.js';
import { analyzeClip } from '../src/analysis.js';
import { writeProject, renderProject } from '../src/renderer.js';
import { compressVideo } from '../src/compress.js';

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
  { cacheFile: path.join(dir, 'analysis.json'), features: { silence: true, shots: true, faces: true }, tools },
);
console.log({ silences: a.silences, shots: a.shots, faces: a.faces?.length, notes: a.notes });
if (a.notes.length) fail(`analysis errors: ${a.notes.join('; ')}`);

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
  clips: [{ id: 'clip1', file: 'clip1.mp4', path: clipPath, hasAudio: true, width: 1280, height: 720 }],
  transcripts: { clip1: { words: [{ word: 'hello', start: 0.2, end: 0.6 }] } },
  settings: { width: 1080, height: 1920, captions: 'bold', framing: 'crop', accent: '#7c5cff' },
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

console.log('\nSMOKE TEST PASSED');

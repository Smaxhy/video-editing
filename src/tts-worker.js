// Child process for Kokoro text-to-speech (kept out of the server so the ~300 MB model is freed after use).
// stdin: { modulePath, lines: [{ text }], voice, speed, outDir }  →  stdout: [{ file, duration }]
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { modulePath, lines, voice, speed, outDir } = JSON.parse(input);

const { KokoroTTS } = await import(pathToFileURL(modulePath).href);
// q8 weights: ~90 MB, near-identical quality to fp32 and several times faster on CPU.
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
const out = [];
for (const [i, line] of lines.entries()) {
  const audio = await tts.generate(line.text, { voice, speed });
  const file = path.join(outDir, `line${String(i).padStart(2, '0')}.wav`);
  await audio.save(file);
  out.push({ file, duration: audio.audio.length / audio.sampling_rate });
}
process.stdout.write(JSON.stringify(out));

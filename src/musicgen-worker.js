// Child process for MusicGen (text → music, transformers.js on ONNX Runtime, CPU). Kept out of the
// server so the ~600 MB of weights are freed as soon as the track is written.
// stdin: { entry, cacheDir, prompt, seconds, out }  →  stdout: { file, seconds, sampleRate }
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { entry, cacheDir, prompt, seconds, out } = JSON.parse(input);

const tf = await import(pathToFileURL(entry).href);
if (cacheDir) tf.env.cacheDir = cacheDir;

const ID = 'Xenova/musicgen-small';
const tokenizer = await tf.AutoTokenizer.from_pretrained(ID);
// q8 text encoder + decoder (fast on CPU); the EnCodec decoder stays fp32 for clean audio.
// Falls back to full precision if a quantised file is missing from the model repo.
const model = await tf.MusicgenForConditionalGeneration.from_pretrained(ID, {
  dtype: { model: 'q8', decoder_model_merged: 'q8', encodec_decode: 'fp32' }, // "model" = the T5 text encoder
  device: 'cpu',
}).catch(() => tf.MusicgenForConditionalGeneration.from_pretrained(ID, { dtype: 'fp32', device: 'cpu' }));
const inputs = tokenizer(prompt);
// 50 audio tokens per second; the model is trained on 30 s clips.
const audio = await model.generate({ ...inputs, max_new_tokens: Math.round(Math.min(30, seconds) * 50), do_sample: true, guidance_scale: 3 });
const sampleRate = model.config.audio_encoder.sampling_rate;
const data = audio.data;

// 16-bit PCM WAV (mono).
const buf = Buffer.alloc(44 + data.length * 2);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + data.length * 2, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(data.length * 2, 40);
for (let i = 0; i < data.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), 44 + i * 2);
await fs.writeFile(out, buf);
process.stdout.write(JSON.stringify({ file: out, seconds: data.length / sampleRate, sampleRate }));

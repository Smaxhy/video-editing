// Long-lived child process for local AI models (transformers.js on ONNX Runtime, CPU):
//   CLIP  (Xenova/clip-vit-base-patch32) — image & text embeddings for "search by meaning"
//   CLAP  (Xenova/clap-htsat-unfused)    — zero-shot sound tags ("chainsaw", "wind", "speech"…)
// Protocol: one JSON request per stdin line { id, method, params } → one JSON line { id, result | error }.
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tf = await import(pathToFileURL(process.env.TRANSFORMERS_ENTRY).href);
if (process.env.MODEL_CACHE) tf.env.cacheDir = process.env.MODEL_CACHE;

const CLIP_ID = 'Xenova/clip-vit-base-patch32';
const CLAP_ID = 'Xenova/clap-htsat-unfused';
let clip = null;
let clap = null;

const getClip = () =>
  (clip ||= (async () => ({
    processor: await tf.AutoProcessor.from_pretrained(CLIP_ID),
    vision: await tf.CLIPVisionModelWithProjection.from_pretrained(CLIP_ID, { dtype: 'q8' }),
    tokenizer: await tf.AutoTokenizer.from_pretrained(CLIP_ID),
    text: await tf.CLIPTextModelWithProjection.from_pretrained(CLIP_ID, { dtype: 'q8' }),
  }))());
const getClap = () => (clap ||= tf.pipeline('zero-shot-audio-classification', CLAP_ID, { dtype: 'q8' }));

const unit = (arr) => {
  let s = 0;
  for (const v of arr) s += v * v;
  s = Math.sqrt(s) || 1;
  return Array.from(arr, (v) => Math.round((v / s) * 1e5) / 1e5);
};
const rows = (tensor) => {
  const [n, d] = tensor.dims;
  return Array.from({ length: n }, (_, i) => unit(tensor.data.slice(i * d, (i + 1) * d)));
};

/** Mono 48 kHz float samples of [start, start + seconds) of a media file. */
function decode(file, start, seconds) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('could not decode audio'));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

const methods = {
  async embedImages({ paths }) {
    const c = await getClip();
    const out = [];
    for (const p of paths) {
      const inputs = await c.processor(await tf.RawImage.read(p));
      const { image_embeds } = await c.vision(inputs);
      out.push(rows(image_embeds)[0]);
    }
    return out;
  },
  async embedText({ texts }) {
    const c = await getClip();
    const inputs = c.tokenizer(texts, { padding: true, truncation: true });
    const { text_embeds } = await c.text(inputs);
    return rows(text_embeds);
  },
  async audioTags({ file, start = 0, seconds = 10, labels }) {
    const classify = await getClap();
    const audio = await decode(file, start, seconds);
    if (audio.length < 48000) return [];
    const res = await classify(audio, labels);
    return (Array.isArray(res) ? res : [res]).map((r) => ({ label: r.label, score: Math.round(r.score * 1000) / 1000 }));
  },
};

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  // One request at a time: the models already use every core.
  queue = queue.then(async () => {
    let msg;
    try {
      msg = JSON.parse(line);
      const result = await methods[msg.method](msg.params || {});
      process.stdout.write(`${JSON.stringify({ id: msg.id, result })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ id: msg?.id, error: String(err?.message || err) })}\n`);
    }
  });
});
rl.on('close', () => queue.then(() => process.exit(0)));

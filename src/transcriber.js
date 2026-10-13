import fs from 'node:fs/promises';
import path from 'node:path';
import { run, tail, probe, exists, round, PipelineError } from './util.js';
import { ROOT, PYTHON } from './tools.js';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large', 'turbo'];
export const ENGINES = ['auto', 'faster-whisper', 'whisperx', 'whisper'];

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';
const FASTER_PY = path.join(ROOT, 'py', 'transcribe_faster.py');
const LONG_NAMES = { large: 'large-v3', turbo: 'large-v3-turbo' };

let cudaCache;
async function hasCuda() {
  if (process.env.WHISPER_DEVICE) return process.env.WHISPER_DEVICE.startsWith('cuda');
  if (cudaCache === undefined) {
    const r = await run(PYTHON, ['-c', 'import torch; print(torch.cuda.is_available())']).catch(() => null);
    cudaCache = r?.stdout.trim() === 'True';
  }
  return cudaCache;
}

/** Command line for one engine. All engines write <stem>.json/.srt/.vtt/.txt/.tsv into outDir. */
async function engineCommand(engine, videoPath, model, outDir) {
  const lang = process.env.WHISPER_LANGUAGE;
  if (engine === 'faster-whisper') {
    const args = [FASTER_PY, videoPath, '--model', model, '--output_dir', outDir];
    if (lang) args.push('--language', lang);
    if (process.env.WHISPER_DEVICE) args.push('--device', process.env.WHISPER_DEVICE);
    return [PYTHON, args, 'faster-whisper (pip install faster-whisper)'];
  }
  if (engine === 'whisperx') {
    const cuda = await hasCuda();
    const args = [
      videoPath, '--model', LONG_NAMES[model] || model, '--output_dir', outDir, '--output_format', 'all',
      '--device', cuda ? 'cuda' : 'cpu', '--compute_type', cuda ? 'float16' : 'int8',
    ];
    if (lang) args.push('--language', lang);
    return ['whisperx', args, 'WhisperX (pip install whisperx)'];
  }
  const args = [
    videoPath, '--model', model, '--output_format', 'all', '--output_dir', outDir,
    '--word_timestamps', 'True', '--verbose', 'False', '--task', 'transcribe',
  ];
  if (process.env.WHISPER_DEVICE) args.push('--device', process.env.WHISPER_DEVICE);
  if (lang) args.push('--language', lang);
  return [WHISPER_BIN, args, 'Whisper (pip install -U openai-whisper)'];
}

/**
 * Transcribe one video.
 *
 * engine: 'auto' (faster-whisper when installed, else openai-whisper), 'faster-whisper',
 * 'whisperx' or 'whisper'. In auto mode a faster-whisper failure falls back to openai-whisper.
 * Writes every output format into outDir and returns
 * { srt, vtt, text, segments, words, language, duration, engine, note, files }.
 * Results are cached per engine+model; anyCached accepts whatever transcript is already there.
 */
export async function transcribe(
  videoPath,
  { model = 'medium', engine = 'auto', tools = {}, outDir, onProgress, signal, label, anyCached = false } = {},
) {
  const name = label || path.basename(videoPath);
  if (!WHISPER_MODELS.includes(model)) {
    throw new PipelineError(`Unknown Whisper model "${model}".`, { hint: `Use one of: ${WHISPER_MODELS.join(', ')}` });
  }
  await fs.mkdir(outDir, { recursive: true });

  const meta = await probe(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const jsonPath = path.join(outDir, `${stem}.json`);
  const markerPath = path.join(outDir, '.model');

  if (!meta.hasAudio) {
    // Nothing to transcribe — return an empty transcript instead of failing the job.
    return emptyTranscript(meta.duration, 'No audio track in this clip.');
  }

  const order = engine === 'auto' ? (tools.fasterWhisper ? ['faster-whisper', 'whisper'] : ['whisper']) : [engine];
  const marker = (await fs.readFile(markerPath, 'utf8').catch(() => '')).trim();
  const cachedOk =
    (await exists(jsonPath)) &&
    (anyCached || order.some((e) => marker === `${e}:${model}` || (e === 'whisper' && marker === model)));

  let usedEngine = marker.includes(':') ? marker.split(':')[0] : 'whisper';
  let note = null;
  if (!cachedOk) {
    let lastErr = null;
    for (const eng of order) {
      try {
        await runEngine(eng, videoPath, model, outDir, { onProgress, signal, name });
        if (!(await exists(jsonPath))) throw new PipelineError(`${eng} finished but wrote no transcript for ${name}.`);
        await fs.writeFile(markerPath, `${eng}:${model}`);
        usedEngine = eng;
        lastErr = null;
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = err;
        if (eng !== order[order.length - 1]) note = `${eng} unavailable for ${name} (${err.hint || err.message}) — used openai-whisper instead.`;
      }
    }
    if (lastErr) throw lastErr;
  }

  const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const read = (ext) => fs.readFile(path.join(outDir, `${stem}.${ext}`), 'utf8').catch(() => '');

  const segments = (raw.segments || []).map((s) => ({
    start: round(s.start),
    end: round(s.end),
    text: String(s.text || '').trim(),
  }));
  // WhisperX leaves start/end off words it couldn't align (e.g. numerals); drop those.
  const words = (raw.segments || [])
    .flatMap((s) => (s.words || []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)))
    .map((w) => ({ start: round(w.start), end: round(w.end), word: String(w.word || '').trim() }))
    .filter((w) => w.word);

  return {
    text: (raw.text || segments.map((s) => s.text).join(' ')).trim(),
    srt: await read('srt'),
    vtt: await read('vtt'),
    segments,
    words,
    language: raw.language || null,
    duration: meta.duration,
    engine: usedEngine,
    note,
    files: ['srt', 'vtt', 'txt', 'tsv', 'json'].map((ext) => path.join(outDir, `${stem}.${ext}`)),
  };
}

async function runEngine(engine, videoPath, model, outDir, { onProgress, signal, name }) {
  const [cmd, args, installHint] = await engineCommand(engine, videoPath, model, outDir);
  let res;
  try {
    res = await run(cmd, args, {
      signal,
      env: { PYTHONUNBUFFERED: '1' },
      onLine: (line) => {
        // tqdm-style progress: " 42%|████▏     | ..."
        const m = line.match(/(\d{1,3})%\|/);
        if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 100));
      },
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PipelineError(`${engine} is not installed.`, { hint: `Install ${installHint} or run scripts/setup.sh.` });
    }
    throw err;
  }
  if (res.code !== 0) {
    const detail = tail(res.stderr || res.stdout);
    let hint;
    if (/No module named/i.test(detail)) hint = `Install ${installHint}.`;
    else if (/out of memory|CUDA error|CUBLAS/i.test(detail)) hint = 'Ran out of GPU memory — pick a smaller model.';
    else if (/urlopen|Connection|download|huggingface|resolve|403|Tunnel/i.test(detail)) {
      hint = 'The speech model downloads on first use — check your internet connection.';
    }
    throw new PipelineError(`${engine} failed on ${name}.`, { detail, hint });
  }
}

function emptyTranscript(duration, note) {
  return { text: '', srt: '', vtt: '', segments: [], words: [], language: null, duration, note, engine: null, files: [] };
}

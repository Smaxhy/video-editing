import fs from 'node:fs/promises';
import path from 'node:path';
import { run, tail, probe, exists, round, PipelineError } from './util.js';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large', 'turbo'];

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper';

/**
 * Transcribe one video with the Whisper CLI.
 *
 * Writes every Whisper output format (.srt .vtt .txt .tsv .json) into outDir and returns
 * { srt, vtt, text, segments, words, language, duration, files }.
 * Results are cached per model: if outDir already holds a JSON transcript from the same
 * model, Whisper is not run again.
 */
export async function transcribe(videoPath, { model = 'medium', outDir, onProgress, signal, label, anyCached = false } = {}) {
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

  // anyCached: accept a transcript made with a different model (used by plan-reuse re-renders).
  const cached =
    (await exists(jsonPath)) && (anyCached || (await fs.readFile(markerPath, 'utf8').catch(() => '')) === model);

  if (!cached) {
    const args = [
      videoPath,
      '--model', model,
      '--output_format', 'all',
      '--output_dir', outDir,
      '--word_timestamps', 'True',
      '--verbose', 'False',
      '--task', 'transcribe',
    ];
    if (process.env.WHISPER_DEVICE) args.push('--device', process.env.WHISPER_DEVICE);
    if (process.env.WHISPER_LANGUAGE) args.push('--language', process.env.WHISPER_LANGUAGE);

    let res;
    try {
      res = await run(WHISPER_BIN, args, {
        signal,
        env: { PYTHONUNBUFFERED: '1' },
        onLine: (line) => {
          // tqdm progress: " 42%|████▏     | 1234/2950 [00:10<00:14, ...]"
          const m = line.match(/(\d{1,3})%\|/);
          if (m && onProgress) onProgress(Number(m[1]) / 100);
        },
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new PipelineError('Whisper CLI not found.', {
          hint: 'Install it with `pip install -U openai-whisper` (or run scripts/setup.sh) and make sure `whisper` is on your PATH.',
        });
      }
      throw err;
    }
    if (res.code !== 0) {
      const detail = tail(res.stderr || res.stdout);
      let hint;
      if (/out of memory|CUDA error|CUBLAS/i.test(detail)) hint = 'Whisper ran out of GPU memory — pick a smaller model.';
      else if (/ffmpeg/i.test(detail) && /not found|No such file/i.test(detail)) hint = 'Whisper needs FFmpeg on your PATH.';
      else if (/urlopen|Connection|download/i.test(detail)) hint = 'Whisper downloads its model on first use — check your internet connection.';
      throw new PipelineError(`Whisper failed on ${name}.`, { detail, hint });
    }
    if (!(await exists(jsonPath))) {
      throw new PipelineError(`Whisper finished but wrote no transcript for ${name}.`, {
        detail: tail(res.stderr || res.stdout),
      });
    }
    await fs.writeFile(markerPath, model);
  }

  const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const read = (ext) => fs.readFile(path.join(outDir, `${stem}.${ext}`), 'utf8').catch(() => '');

  const segments = (raw.segments || []).map((s) => ({
    start: round(s.start),
    end: round(s.end),
    text: s.text.trim(),
  }));
  const words = (raw.segments || []).flatMap((s) =>
    (s.words || []).map((w) => ({ start: round(w.start), end: round(w.end), word: w.word.trim() })),
  ).filter((w) => w.word);

  return {
    text: (raw.text || '').trim(),
    srt: await read('srt'),
    vtt: await read('vtt'),
    segments,
    words,
    language: raw.language || null,
    duration: meta.duration,
    files: ['srt', 'vtt', 'txt', 'tsv', 'json'].map((ext) => path.join(outDir, `${stem}.${ext}`)),
  };
}

function emptyTranscript(duration, note) {
  return { text: '', srt: '', vtt: '', segments: [], words: [], language: null, duration, note, files: [] };
}

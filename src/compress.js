import fs from 'node:fs/promises';
import { run, tail, PipelineError } from './util.js';

/**
 * Output size presets. All are H.264 + AAC MP4 with +faststart, which every social platform,
 * ad manager and browser accepts.
 *  - small:    visibly clean on phones, typically 1-3 MB per 30s of 1080p
 *  - balanced: near-transparent, about half the size of the raw render
 *  - max:      the HyperFrames "delivery" video stream as-is (largest, highest quality)
 * Audio is always loudness-normalized to -14 LUFS / -1.5 dBTP (two-pass with ffmpeg-normalize
 * when installed, otherwise FFmpeg's single-pass loudnorm), the level TikTok, Instagram
 * and YouTube normalize to, so videos don't sound quiet next to everything else in the feed.
 */
const LOUDNORM = 'loudnorm=I=-14:TP=-1.5:LRA=11';
export const SIZE_PRESETS = {
  small: { label: 'Small', crf: 28, preset: 'slow', audio: '96k', maxrate: '3M' },
  balanced: { label: 'Balanced', crf: 23, preset: 'slow', audio: '128k', maxrate: '8M' },
  max: { label: 'Max quality', crf: null, audio: '192k' },
};

/** Which HyperFrames render quality feeds each size preset. */
export const RENDER_QUALITY = { small: 'looks', balanced: 'looks', max: 'delivery' };

/**
 * Re-encode `input` to `output` according to the preset. Deletes the input afterwards.
 * Returns the output size in bytes.
 */
export async function compressVideo(input, output, presetName = 'balanced', { signal, twoPass = false } = {}) {
  const p = SIZE_PRESETS[presetName] || SIZE_PRESETS.balanced;
  const videoArgs =
    p.crf == null
      ? []
      : [
          '-preset', p.preset, '-crf', String(p.crf),
          '-maxrate', p.maxrate, '-bufsize', p.maxrate.replace(/\d+/, (n) => String(Number(n) * 2)),
          '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        ];
  const videoCodec = p.crf == null ? 'copy' : 'libx264';

  let ok = false;
  if (twoPass) {
    // ffmpeg-normalize: measure first, then apply exact linear gain (EBU R128, two-pass).
    const res = await run('ffmpeg-normalize', [
      input, '-o', output, '-f', '-nt', 'ebu', '-t', '-14', '-tp', '-1.5', '-lrt', '11',
      '-c:a', 'aac', '-b:a', p.audio, '-ar', '48000',
      '-c:v', videoCodec, '-e', JSON.stringify([...videoArgs, '-ac', '2', '-movflags', '+faststart']),
    ], { signal }).catch(() => null);
    ok = res?.code === 0 && (await fs.stat(output).catch(() => null))?.size > 0;
    // Fails on videos without an audio track, among others — fall through to plain FFmpeg.
  }
  if (!ok) {
    // -ar 48000: loudnorm upsamples internally, so pin the output rate.
    const args = ['-v', 'error', '-y', '-i', input, '-c:v', videoCodec, ...videoArgs,
      '-af', LOUDNORM, '-c:a', 'aac', '-b:a', p.audio, '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output];
    const res = await run('ffmpeg', args, { signal });
    if (res.code !== 0) {
      throw new PipelineError('Compressing the video failed.', { detail: tail(res.stderr) });
    }
  }

  // Never keep a "compressed" file that came out bigger than the source (video-copy is exempt).
  const [inSize, outSize] = await Promise.all([fs.stat(input).then((s) => s.size), fs.stat(output).then((s) => s.size)]);
  if (p.crf != null && outSize > inSize) {
    await fs.rm(output, { force: true });
    await fs.rename(input, output);
    return inSize;
  }
  await fs.rm(input, { force: true });
  return outSize;
}

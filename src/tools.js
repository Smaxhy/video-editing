import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

/** True when `bin` is an existing absolute path or an executable on PATH. */
export function onPath(bin) {
  if (path.isAbsolute(bin)) return fsSync.existsSync(bin);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return (process.env.PATH || '')
    .split(path.delimiter)
    .some((dir) => exts.some((e) => fsSync.existsSync(path.join(dir, bin + e))));
}

/**
 * Optional open-source tools ClipForge can use. Each one is detected at runtime;
 * when it's missing the matching feature is skipped (or falls back) instead of failing.
 */
export const OPTIONAL_TOOLS = {
  fasterWhisper: { name: 'faster-whisper', url: 'https://github.com/SYSTRAN/faster-whisper', does: 'Faster transcription (CTranslate2), same accuracy' },
  whisperx: { name: 'WhisperX', url: 'https://github.com/m-bain/whisperX', does: 'Word timings via forced alignment — tightest cuts & captions' },
  autoEditor: { name: 'auto-editor', url: 'https://github.com/WyattBlue/auto-editor', does: 'Finds silent ranges by loudness (dead-air removal)' },
  sceneDetect: { name: 'PySceneDetect', url: 'https://github.com/Breakthrough/PySceneDetect', does: 'Finds shot changes so Claude can cut B-roll and montage' },
  faces: { name: 'OpenCV face tracking', url: 'https://github.com/opencv/opencv-python', does: 'Keeps the speaker centred when reframing to 9:16' },
  demucs: { name: 'Demucs', url: 'https://github.com/adefossez/demucs', does: 'Isolates the voice from music and background noise' },
  ffmpegNormalize: { name: 'ffmpeg-normalize', url: 'https://github.com/slhck/ffmpeg-normalize', does: 'Two-pass EBU R128 loudness to -14 LUFS' },
  rembg: { name: 'rembg', url: 'https://github.com/danielgatis/rembg', does: 'Cuts the background out of your logo / product image' },
  rclone: { name: 'rclone', url: 'https://github.com/rclone/rclone', does: 'Imports whole folders from Google Drive (and Dropbox, OneDrive, S3…)' },
};

let cache = null;

/** Detect which optional tools are installed. Cached for a minute. */
export async function detectTools({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.tools;
  const check = `
import importlib.util as u, json
def has(m):
    try: return u.find_spec(m) is not None
    except Exception: return False
faces = False
if has("cv2"):
    try:
        import cv2, os
        faces = os.path.exists(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    except Exception: pass
print(json.dumps({"fasterWhisper": has("faster_whisper"), "sceneDetect": has("scenedetect") and has("cv2"),
                  "faces": faces, "demucs": has("demucs")}))`;
  let py = {};
  try {
    const res = await run(PYTHON, ['-c', check], { timeoutMs: 30_000 });
    if (res.code === 0) py = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    /* no python: every python-backed tool reads as missing */
  }
  const tools = {
    fasterWhisper: Boolean(py.fasterWhisper),
    whisperx: onPath('whisperx'),
    autoEditor: onPath('auto-editor'),
    sceneDetect: Boolean(py.sceneDetect),
    faces: Boolean(py.faces),
    demucs: Boolean(py.demucs) || onPath('demucs'),
    ffmpegNormalize: onPath('ffmpeg-normalize'),
    rembg: onPath('rembg'),
    rclone: onPath(process.env.RCLONE_BIN || 'rclone') || fsSync.existsSync(path.join(ROOT, '.tools', 'rclone-v1.71.2')),
  };
  cache = { at: Date.now(), tools };
  return tools;
}

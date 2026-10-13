# ClipForge

Local AI video editor. Drop in your clips, say what you want in plain English, and get back finished videos sized for social media and ads in several lengths at once.

```
Browser (clips + prompt)
   │
   ▼
Express server (localhost:3000)
   ├─▶ Whisper          transcribes every clip (word-level timestamps)          — local
   ├─▶ claude -p        plans every version in ONE call (cuts, overlays, CTA)   — your Claude subscription
   ├─▶ HyperFrames      renders each length × format to MP4                     — local
   ├─▶ FFmpeg           compresses + normalizes loudness to -14 LUFS            — local
   └─▶ Browser          preview + download each version
```

**No credits, no API keys, no cloud.** Whisper, HyperFrames and FFmpeg run on your machine. The edit planning is done by the Claude Code CLI in pipe mode (`claude -p`), which uses your existing Claude subscription. HyperFrames telemetry is switched off for every render.

## Quick start

```bash
bash scripts/setup.sh   # checks Node 22+, Python 3.9+, FFmpeg, Claude CLI; installs Whisper + HyperFrames
npm start               # → http://localhost:3000
```

If `claude` has never been run on this machine, run it once in a terminal and log in.
The first transcription downloads the Whisper model you picked (medium ≈ 1.5 GB).

## Using it

1. **Clips:** drag in one or more videos.
2. **Prompt:** describe the edit. Claude treats your words as the highest authority. Quoted text is used word for word, and anything you say to cut gets cut. Things you don't mention are filled in by the style guide for your goal.
3. **Output:**
   | Option | Choices |
   | --- | --- |
   | Made for | **Social** (hook in 1.5s, fast pacing, punch-ins on jump cuts) · **Advertisement** (hook → problem → solution → CTA end card) · **Both** |
   | Formats | **9:16** TikTok/Reels/Shorts · **4:5** feed ads · **1:1** square · **16:9** YouTube/web. Pick several. |
   | Lengths | **15s · 30s · 60s · Full**. Pick several. Each length is its own edit, not a trim. |
   | Captions | **Bold** (social style, 1–3 words, pop-in) · **Clean** (subtitle box) · **Off**. Generated from Whisper's word timings and kept clear of platform UI. |
   | Framing | **Blur fill** (fit the shot, blurred copy behind it) · **Crop to fill** · **Fit** (black bars) |
   | File size | **Small** (~1–2 MB per 30s) · **Balanced** · **Max quality** |
   | Brand | Brand name, call to action and accent colour. These are used verbatim in the CTA end card and lower-thirds. |
4. **Forge:** you get every combination (up to 8) as a gallery with previews and downloads. You also get a **"What Claude did"** checklist that maps each instruction in your prompt to exactly how it was handled.

**Re-render only:** after a run, change formats, captions, framing, size or colours and hit *Re-render only*. ClipForge reuses the saved plan and transcripts, so no Claude call is made.

## Storage

- Outputs are H.264/AAC MP4 with `+faststart`, which every platform accepts. Each run replaces the previous run's outputs.
- The storage card under the results shows how much disk the project uses. **Delete project files** removes its uploads, transcripts, caches and renders.
- Caches kept per project: Whisper transcripts, seek-safe copies of clips with sparse keyframes, and tiny blurred backgrounds. All of them are reused across runs.

## Folder layout

```
src/server.js       Express app, job queue, SSE progress, downloads, storage
src/transcriber.js  whisper CLI wrapper (all output formats, cached per model)
src/editor.js       prompt builder + claude -p call + plan validation
src/renderer.js     plan → HyperFrames HTML composition, blur fill, seek-safe sources, render
src/compress.js     size presets + loudness normalization
public/index.html   the UI
uploads/{jobId}/    your clips          workspace/{jobId}/  transcripts, plans, logs, caches
output/{jobId}/     rendered videos
```

Each run leaves its working files in `workspace/{jobId}/`: `claude-prompt.md`, `claude-response.txt`, `edit-plan.json`, `transcripts.json` and `render-*.log`. They're useful when an edit isn't what you expected.

## Configuration (env vars)

| Var | Default | |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Set `HOST=0.0.0.0` to reach it from other devices on your network |
| `WHISPER_BIN` | `whisper` | Path to the Whisper CLI |
| `WHISPER_DEVICE` | auto | e.g. `cuda`, `cpu` |
| `WHISPER_LANGUAGE` | auto-detect | e.g. `en` |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CLAUDE_MODEL` | CLI default | Passed as `--model` |
| `CLAUDE_TIMEOUT_MS` | `600000` | |
| `MAX_UPLOAD_MB` | `4096` | Per file |

## HTTP API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/health` | Tool availability and option lists |
| `POST` | `/api/upload[?jobId=]` | multipart `clips` (multiple). Creates or extends a project |
| `POST` | `/api/edit` | `{ jobId, prompt, settings: { goal, formats[], lengths[], captions, framing, size, brand, cta, accent, whisperModel }, reusePlan? }` |
| `GET` | `/api/status/:jobId` | Server-Sent Events: full job snapshot on every change |
| `GET` | `/api/download/:jobId/:variantId[?inline=1]` | A rendered MP4, e.g. `30-9x16` |
| `POST` | `/api/cancel/:jobId` | Stop a running job |
| `GET` / `DELETE` | `/api/storage?jobId=` / `/api/jobs/:jobId` | Disk usage / delete a project |

## Troubleshooting

The status pills in the header show whether FFmpeg, Whisper, Claude and HyperFrames were found. Errors in the UI come with a hint and the tool's own output under *Technical details*.

- **"Claude Code is not logged in"**: run `claude` once in a terminal.
- **Usage limit hit**: wait for the reset. Uploads and transcripts are kept, so a retry starts at the planning step.
- **Whisper is slow**: use the `base` or `turbo` model under *Advanced*, or a GPU (`WHISPER_DEVICE=cuda`).
- **Render can't find Chrome**: `npx hyperframes browser ensure`.

## Tests

```bash
npm test
```

## Roadmap: open-source projects that would make this better

From a survey of well-starred GitHub projects (star counts are approximate):

| Project | What it would add to ClipForge |
| --- | --- |
| [m-bain/whisperX](https://github.com/m-bain/whisperx) (~17k ★) / [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Transcription several times faster on the same hardware, and tighter word timestamps via forced alignment, so cuts and captions land exactly on words. Optional speaker diarization ("keep only the guest's answers"). Highest-value swap. |
| [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor) (~4k ★) | Loudness-based silence detection. Feeding Claude exact silent ranges would make dead-air removal precise even on clips with music or no speech. |
| [Breakthrough/PySceneDetect](https://github.com/Breakthrough/PySceneDetect) (~4k ★) | Shot-boundary detection. Today Claude only "hears" the footage; scene cuts would let it edit B-roll and montage footage too. |
| Face-tracked reframing (as in [SamurAIGPT/AI-Youtube-Shorts-Generator](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator), ~3.6k ★) | Keep the speaker centred when turning 16:9 into 9:16, instead of blur fill or a centre crop. |
| [adefossez/demucs](https://github.com/adefossez/demucs) | Separate voice from background music: clean up noisy audio, or duck the original music under a new track. |
| [slhck/ffmpeg-normalize](https://github.com/slhck/ffmpeg-normalize) | Two-pass EBU R128 loudness for exact targets. ClipForge already does single-pass `loudnorm` to -14 LUFS. |
| [danielgatis/rembg](https://github.com/danielgatis/rembg) (~22k ★) | Background removal for logos and product shots in ad end cards. |

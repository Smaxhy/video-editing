# ClipForge

Local AI video editor. Drop in your clips, say what you want in plain English, and get back finished videos sized for social media and ads in several lengths at once. Works from your PC and your phone.

```
Phone / PC browser (installable app)
   │
   ▼
ClipForge server (your PC, a home server or a VPS)
   ├─▶ Whisper / faster-whisper / WhisperX   transcribe with word timings            — local
   ├─▶ auto-editor · PySceneDetect · OpenCV   silences, shot changes, face positions  — local
   ├─▶ claude -p                              plans every version in ONE call         — your Claude subscription
   ├─▶ Demucs · rembg                         clean voice, logo cutout                — local
   ├─▶ HyperFrames                            renders each length × format to MP4     — local
   └─▶ FFmpeg · ffmpeg-normalize              compress + loudness to -14 LUFS         — local
```

**No credits, no API keys.** Everything runs on a machine you control. Edit planning uses the Claude Code CLI in pipe mode (`claude -p`), which runs on your existing Claude subscription. HyperFrames telemetry is switched off.

**Subscription, never Console credits.** Claude Code would bill your Console API account if an `ANTHROPIC_API_KEY` is set. ClipForge removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment before every `claude -p` call, so planning always runs on your Pro/Max subscription: your `claude` login, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on servers. Set `CLIPFORGE_ALLOW_API_KEY=1` only if you actually want API billing.

## Quick start (PC)

```bash
bash scripts/setup.sh   # checks Node 22+, Python 3.9+, FFmpeg, Claude CLI; installs Whisper, HyperFrames + smart tools
npm start               # → http://localhost:3000
```

If `claude` has never been run on this machine, run it once in a terminal and log in.
Setup flags: `--minimal` installs only Whisper and HyperFrames. `--whisperx` also installs WhisperX, which is heavy and pins its own PyTorch version.
Speech models download the first time you use them (Whisper medium ≈ 1.5 GB).

## Use it on your phone and PC

The phone is the remote control and the computer does the heavy lifting. Whisper, Demucs and HyperFrames' headless Chrome need a real computer, and the Claude Code CLI doesn't run on phones. So ClipForge runs as a small server and your phone (or any PC) opens it like an app. Pick one way to reach it:

| Option | Cost | PC must be on? | Setup |
| --- | --- | --- | --- |
| **A. Same Wi-Fi** | free | yes | `CLIPFORGE_PASSWORD="long-password" npm run start:lan`, then open the printed `http://192.168.x.x:3000` on your phone |
| **B. Anywhere: [Tailscale](https://tailscale.com)** (recommended) | free | yes | Install Tailscale on PC + phone, run option A, then `tailscale serve --bg 3000` → open `https://<pc-name>.<tailnet>.ts.net` |
| **C. Always on: server / VPS** | VPS from ~€5/mo, or free on [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) (CPU only, slower) | no | Docker: see below |

Option B gives you HTTPS. That enables **Install app** on Android, the **Share** button (post straight to TikTok or Instagram from the phone), and offline loading of the app shell. With plain `http://` on Wi-Fi everything else works, and iPhone's *Add to Home Screen* still works.

**Install it like an app:**
- iPhone: open the link in Safari, tap Share, then *Add to Home Screen*.
- Android: open it in Chrome, tap ⋮, then *Install app*.
- PC: Chrome or Edge, then the install icon in the address bar.

**Password:** listening beyond localhost *requires* `CLIPFORGE_PASSWORD`, because anyone who can reach the server could otherwise spend your Claude usage. ClipForge refuses to start in LAN mode without one. Sessions last 30 days, and failed logins are rate-limited.

### Docker (option C)

```bash
# on any computer with Claude Code installed:
claude setup-token            # prints a long-lived token for your subscription
# on the server, next to docker-compose.yml, create .env:
#   CLIPFORGE_PASSWORD=pick-something-long
#   CLAUDE_CODE_OAUTH_TOKEN=<token from above>
docker compose up -d          # → http://<server>:3000
```

Put HTTPS in front of it: Tailscale (`tailscale serve --bg 3000` on the server), or a reverse proxy such as [Caddy](https://caddyserver.com) with your own domain. The image is CPU-only by default. For an NVIDIA GPU, build with `--build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124` and add GPU access to the compose service.

## Using it

1. **Clips:** drag in videos (on phones, tap to pick from the camera roll).
2. **Prompt:** describe the edit. Claude treats your words as the highest authority. Quoted text is used word for word, and anything you say to cut gets cut. Gaps are filled by the style guide for your goal.
3. **Output:**
   | Option | Choices |
   | --- | --- |
   | Made for | **Social** (hook in 1.5s, fast pacing, punch-ins on jump cuts) · **Advertisement** (hook → problem → solution → CTA end card) · **Both** |
   | Formats | **9:16** TikTok/Reels/Shorts · **4:5** feed ads · **1:1** square · **16:9** YouTube/web. Pick several. |
   | Lengths | **15s · 30s · 60s · Full**. Pick several. Each length is its own edit. |
   | Captions | **Bold** (social style, pop-in) · **Clean** (subtitle box) · **Off**. Generated from word timings and kept clear of platform UI. |
   | Framing | **Blur fill** · **Face crop** (keeps the speaker centred) · **Crop to fill** · **Fit** |
   | File size | **Small** (~1–2 MB / 30s) · **Balanced** · **Max quality** |
   | Brand | Name, call to action and accent colour (used verbatim), plus a **logo or product image**. Its background can be removed automatically, and it can be shown as a corner **watermark**. |
   | Smart tools | **Precise dead-air removal** · **Shot detection** · **Clean voice** |
4. **Forge:** every combination (up to 8) appears in a gallery with preview, **Share** (phones) and download. You also get a **"What Claude did"** checklist mapping each instruction to exactly how it was handled.

**Re-render only:** change formats, captions, framing, size, colours or logo and re-render from the saved plan, with no Claude call.

## Open-source tools inside ClipForge

Each tool is detected automatically. When one is missing, its feature is skipped or falls back, and the UI says so. *Open-source tools ClipForge uses* (bottom of the right column) shows what's installed.

| Tool | Stars* | What ClipForge uses it for | Fallback when missing |
| --- | --- | --- | --- |
| [OpenAI Whisper](https://github.com/openai/whisper) | ~90k | Speech-to-text (core) | required unless faster-whisper is installed |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | — | HTML → MP4 rendering (core) | required |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | ~15k | Same accuracy as Whisper, several times faster, lighter on memory. Used automatically ("Auto" engine). | openai-whisper |
| [WhisperX](https://github.com/m-bain/whisperX) | ~17k | Forced-alignment word timings for the tightest cuts and captions (pick it under *Advanced*) | — |
| [auto-editor](https://github.com/WyattBlue/auto-editor) | ~4k | Measures silent ranges; Claude cuts dead air precisely | FFmpeg `silencedetect` |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | ~4k | Finds camera cuts so Claude can edit B-roll and montage, not just speech | feature skipped |
| [OpenCV](https://github.com/opencv/opencv-python) | ~5k | Face tracking for **Face crop** reframing (the technique from [AI-Youtube-Shorts-Generator](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator)) | centre crop |
| [Demucs](https://github.com/adefossez/demucs) | ~9k | **Clean voice**: separates speech from music and noise | original audio |
| [ffmpeg-normalize](https://github.com/slhck/ffmpeg-normalize) | ~1k | Two-pass EBU R128 loudness to -14 LUFS (what TikTok, Instagram and YouTube target) | FFmpeg single-pass `loudnorm` |
| [rembg](https://github.com/danielgatis/rembg) | ~22k | Removes the background from your logo or product image for the CTA card and watermark | image used as-is |
| [GSAP](https://github.com/greensock/GSAP) · [FFmpeg](https://ffmpeg.org) | — | Animation runtime and all media plumbing | required |

\*Approximate GitHub stars at the time of writing.

## Storage

- Outputs are H.264/AAC MP4 with `+faststart`, which every platform accepts. Each run replaces the previous run's outputs.
- The storage card under the results shows the project's disk use. **Delete project files** removes its uploads, transcripts, caches and renders.
- Per-project caches are reused across runs: transcripts, analysis, seek-safe copies of clips with sparse keyframes, blurred backgrounds and isolated voice tracks.

## Folder layout

```
src/server.js       Express app, auth, jobs, SSE progress, downloads, storage
src/transcriber.js  whisper / faster-whisper / WhisperX (all output formats, cached)
src/analysis.js     silences, shots + faces (py/analyze.py), Demucs, rembg
src/editor.js       prompt builder + claude -p call + plan validation
src/renderer.js     plan → HyperFrames composition, framing, seek-safe sources, render
src/compress.js     size presets + loudness normalization
src/auth.js         password protection for phone / LAN / server use
src/tools.js        optional-tool detection
py/                 Python helpers (faster-whisper writer, footage analysis)
public/             the app (UI, manifest, service worker, icons)
```

Every run leaves its working files in `workspace/{jobId}/`: `claude-prompt.md`, `claude-response.txt`, `edit-plan.json`, `transcripts.json`, `analysis/` and `render-*.log`.

## Configuration (env vars)

| Var | Default | |
| --- | --- | --- |
| `CLIPFORGE_PASSWORD` | — | Required for `npm run start:lan` / Docker |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | `--lan` sets the host to `0.0.0.0` |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | For servers/Docker: from `claude setup-token` (subscription) |
| `CLIPFORGE_ALLOW_API_KEY` | off | `1` lets `claude -p` use `ANTHROPIC_API_KEY` (Console billing) |
| `CLAUDE_BIN` / `CLAUDE_MODEL` / `CLAUDE_TIMEOUT_MS` | `claude` / CLI default / `600000` | |
| `WHISPER_BIN` / `WHISPER_DEVICE` / `WHISPER_LANGUAGE` | `whisper` / auto / auto-detect | |
| `PYTHON_BIN` | `python3` | Interpreter used for the Python helpers |
| `MAX_UPLOAD_MB` | `4096` | Per file |

## HTTP API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/health` | Tools installed + option lists |
| `POST` | `/api/login` · `/api/logout` · `GET /api/auth` | Password session (when enabled) |
| `POST` | `/api/upload[?jobId=]` | multipart `clips` |
| `POST` | `/api/logo?jobId=&cutout=1` | multipart `logo` (PNG/JPG/WebP) |
| `POST` | `/api/edit` | `{ jobId, prompt, settings, reusePlan? }`: settings are `goal, formats[], lengths[], captions, framing, size, brand, cta, accent, silence, shots, cleanVoice, watermark, engine, whisperModel` |
| `GET` | `/api/status/:jobId` | Server-Sent Events: full job snapshot on every change |
| `GET` | `/api/download/:jobId/:variantId[?inline=1]` | A rendered MP4, e.g. `30-9x16` |
| `POST` | `/api/cancel/:jobId` | Stop a running job |
| `GET` / `DELETE` | `/api/storage?jobId=` / `/api/jobs/:jobId` | Disk usage / delete a project |

## Troubleshooting

The header dots show whether FFmpeg, Whisper, Claude and HyperFrames were found. Errors come with a hint and the tool's own output under *Technical details*.

- **"Claude Code is not logged in"**: run `claude` once in a terminal (on a server, set `CLAUDE_CODE_OAUTH_TOKEN`).
- **Usage limit hit**: wait for the reset. Uploads, transcripts and analysis are kept.
- **Slow transcription**: install faster-whisper (setup does this), use the `base`/`turbo` model, or use a GPU.
- **Clean voice is slow**: Demucs takes roughly real-time or slower on CPU. Leave it off unless the audio has music or noise.
- **Render can't find Chrome**: `npx hyperframes browser ensure`.

## Tests

```bash
npm test
```

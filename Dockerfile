# ClipForge server image: Whisper + faster-whisper + every optional tool + HyperFrames + Claude Code CLI.
# Build:  docker build -t clipforge .
# Run:    see docker-compose.yml (needs CLIPFORGE_PASSWORD and CLAUDE_CODE_OAUTH_TOKEN).
FROM node:22-bookworm-slim

# FFmpeg, Python, fonts, and the shared libraries HyperFrames' headless Chrome needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv ca-certificates curl git rclone \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Python tools in a venv. CPU-only PyTorch keeps the image ~2 GB smaller; for an NVIDIA GPU
# build with --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH PYTHON_BIN=/opt/venv/bin/python
RUN pip install --no-cache-dir torch torchaudio --index-url ${TORCH_INDEX} \
 && pip install --no-cache-dir openai-whisper faster-whisper demucs \
      scenedetect "opencv-python-headless>=4.8,<5" ffmpeg-normalize auto-editor "rembg[cpu,cli]" \
 && (auto-editor --version || true)

# Claude Code CLI — authenticates with your subscription via CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx hyperframes browser ensure
COPY . .

ENV PORT=3000 HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1
EXPOSE 3000
VOLUME ["/app/library", "/app/uploads", "/app/workspace", "/app/output", "/root/.cache", "/root/.config/rclone"]
CMD ["node", "src/server.js", "--lan"]

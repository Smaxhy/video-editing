# ClipForge server image — runs on Intel/AMD (amd64) and ARM (arm64, e.g. Oracle Cloud free tier).
# Contains: Node 22, FFmpeg, Whisper + faster-whisper + smart tools (CPU PyTorch), HyperFrames with an
# arch-native headless Chrome, and the Claude Code CLI (authenticated with CLAUDE_CODE_OAUTH_TOKEN).
FROM node:22-bookworm-slim

# Set automatically by BuildKit (`docker build` / `docker compose build`).
ARG TARGETARCH=amd64
# Pinned Playwright release that provides a linux-arm64 chrome-headless-shell
# (Chrome for Testing has no arm64 Linux build) — same pin HyperFrames' own render image uses.
ARG PLAYWRIGHT_VERSION=1.61.1
# CPU-only PyTorch wheels (~2 GB smaller than CUDA). For an NVIDIA GPU host build with
#   --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip ffmpeg python3 python3-venv rclone \
      libgbm1 libnss3 libatk-bridge2.0-0 libatk1.0-0 libdrm2 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libxkbcommon0 libcups2 libasound2 libpangocairo-1.0-0 libxshmfence1 libgtk-3-0 \
      fonts-liberation fonts-noto-color-emoji fonts-noto-core fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/* && fc-cache -f

# Python tools in a venv. The core (Whisper) must install; the smart tools are best-effort so one
# unavailable wheel on an architecture never breaks the image — ClipForge detects what's there.
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHON_BIN=/opt/venv/bin/python \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# Upgrade pip first: Debian's pip 23.0 rejects PyTorch's index metadata ("inconsistent Name:
# expected 'typing-extensions'"), falls back to building from source and fails.
RUN pip install --upgrade pip setuptools wheel \
 && pip install torch torchaudio --index-url ${TORCH_INDEX} \
 && pip install openai-whisper
RUN for pkg in faster-whisper scenedetect "opencv-python-headless>=4.8,<5" ffmpeg-normalize \
               "rembg[cpu,cli]" demucs auto-editor; do \
      pip install "$pkg" || echo "WARNING: optional tool $pkg failed to install on ${TARGETARCH}"; \
    done \
 && pip uninstall -y opencv-python 2>/dev/null; \
    pip install --force-reinstall --no-deps "opencv-python-headless>=4.8,<5" || true; \
    (auto-editor --version >/dev/null 2>&1 || echo "auto-editor binary unavailable — FFmpeg silence detection will be used")

# Claude Code CLI — runs on your Pro/Max subscription via CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Arch-native headless Chrome for HyperFrames, kept OUT of /root/.cache (a volume) so rebuilds update it.
ENV PUPPETEER_CACHE_DIR=/opt/browsers/puppeteer \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers/playwright
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      npx --yes playwright-core@${PLAYWRIGHT_VERSION} install chromium-headless-shell; \
    else \
      npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path /opt/browsers/puppeteer; \
    fi \
 && SHELL_PATH=$(find /opt/browsers \( -name chrome-headless-shell -o -name headless_shell \) -type f | head -1) \
 && test -n "$SHELL_PATH" || { echo "ERROR: headless Chrome install failed for ${TARGETARCH}" >&2; exit 1; } \
 && echo "$SHELL_PATH" > /opt/browsers/headless-shell-path \
 && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN install -m 0755 deploy/docker-entrypoint.sh /usr/local/bin/clipforge-entrypoint
# Optional WhisperX (own venv, pinned older PyTorch): build with --build-arg WITH_WHISPERX=1
ARG WITH_WHISPERX=0
RUN if [ "$WITH_WHISPERX" = "1" ]; then bash deploy/install-whisperx.sh; fi

# Model caches (Whisper, Hugging Face, Demucs, rembg) live under /root/.cache — mount it as a volume.
ENV PORT=3000 \
    U2NET_HOME=/root/.cache/u2net \
    HYPERFRAMES_NO_TELEMETRY=1 \
    DO_NOT_TRACK=1
EXPOSE 3000
VOLUME ["/app/library", "/app/uploads", "/app/workspace", "/app/output", "/root/.cache", "/root/.config/rclone"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["clipforge-entrypoint"]
CMD ["node", "src/server.js", "--lan"]

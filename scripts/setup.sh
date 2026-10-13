#!/usr/bin/env bash
# ClipForge one-command installer.
# Checks Node 22+, Python 3.9+, FFmpeg and the Claude Code CLI, then installs
# OpenAI Whisper (pip), HyperFrames (npm) and the project's npm dependencies.
set -uo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }
FAILED=0

bold "ClipForge setup"
echo

# --- Node.js 22+ --------------------------------------------------------------
bold "Checking prerequisites"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$NODE_MAJOR" -ge 22 ]; then ok "Node.js $(node -v)"
  else fail "Node.js $(node -v) found — HyperFrames needs Node 22+ (https://nodejs.org)"; fi
else
  fail "Node.js not found — install Node 22+ from https://nodejs.org"
fi

# --- Python 3.9+ --------------------------------------------------------------
PYTHON=""
for p in python3 python; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PYTHON="$p"; break
  fi
done
if [ -n "$PYTHON" ]; then ok "Python $($PYTHON -c 'import platform; print(platform.python_version())')"
else fail "Python 3.9+ not found — install it from https://python.org"; fi

# --- FFmpeg -------------------------------------------------------------------
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ok "FFmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
else
  fail "FFmpeg not found — macOS: brew install ffmpeg · Ubuntu/Debian: sudo apt install ffmpeg · Windows: winget install ffmpeg"
fi

# --- Claude Code CLI ----------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code CLI $(claude --version 2>/dev/null | head -1)"
else
  warn "Claude Code CLI not found — installing with npm…"
  if npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
    ok "Claude Code CLI installed — run \`claude\` once to log in with your subscription"
  else
    fail "Could not install Claude Code. Run: npm install -g @anthropic-ai/claude-code"
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo
  bold "Fix the items marked ✗ above and re-run: bash scripts/setup.sh"
  exit 1
fi

echo
# --- Whisper ------------------------------------------------------------------
bold "Installing OpenAI Whisper"
if command -v whisper >/dev/null 2>&1; then
  ok "whisper already installed ($(command -v whisper))"
else
  PIP_FLAGS=(-U openai-whisper)
  # Debian/Ubuntu "externally managed" Pythons need --user (or a venv); try plain first.
  if ! "$PYTHON" -m pip install "${PIP_FLAGS[@]}"; then
    warn "pip install failed — retrying with --user"
    "$PYTHON" -m pip install --user "${PIP_FLAGS[@]}" || "$PYTHON" -m pip install --user --break-system-packages "${PIP_FLAGS[@]}"
  fi
  if command -v whisper >/dev/null 2>&1; then
    ok "whisper installed"
  else
    USER_BIN=$("$PYTHON" -c 'import site, os; print(os.path.join(site.USER_BASE, "bin"))')
    if [ -x "$USER_BIN/whisper" ]; then
      warn "whisper installed to $USER_BIN — add it to your PATH:  export PATH=\"$USER_BIN:\$PATH\""
    else
      fail "whisper did not install. Try: $PYTHON -m pip install -U openai-whisper"
    fi
  fi
fi

echo
# --- Node deps + HyperFrames --------------------------------------------------
bold "Installing project dependencies (Express, Multer, HyperFrames, GSAP)"
npm install || fail "npm install failed"
if [ -x node_modules/.bin/hyperframes ]; then
  ok "HyperFrames $(node_modules/.bin/hyperframes --version 2>/dev/null | tail -1)"
else
  fail "HyperFrames CLI missing from node_modules — try: npm install hyperframes"
fi

echo
bold "Installing HyperFrames' headless Chrome"
if node_modules/.bin/hyperframes browser ensure; then ok "Chrome ready"
else warn "Could not fetch Chrome now — HyperFrames will retry on first render (npx hyperframes browser ensure)"; fi

# --- Directories --------------------------------------------------------------
mkdir -p uploads workspace output
ok "Created uploads/, workspace/, output/"

echo
if [ "$FAILED" -ne 0 ]; then
  bold "Setup finished with errors — see ✗ above."
  exit 1
fi
bold "All set. Start ClipForge with:  npm start   →  http://localhost:3000"
echo "Tip: the first transcription downloads the Whisper model (medium ≈ 1.5 GB)."

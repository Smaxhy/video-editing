#!/usr/bin/env bash
# Install WhisperX for ClipForge (tightest word timings → tighter cuts and captions).
#
# WhisperX pins an older PyTorch (2.8) than ClipForge's main environment uses, so it gets its own
# Python environment in /opt/whisperx and only its `whisperx` command is linked onto the PATH,
# where ClipForge detects it. Nothing else is touched.
#
#   Codespace terminal:   bash deploy/install-whisperx.sh
#   Docker server:        sudo docker exec -it clipforge bash deploy/install-whisperx.sh
#   (or build the image with WITH_WHISPERX=1 so it survives rebuilds)
set -euo pipefail

VENV="${WHISPERX_VENV:-/opt/whisperx}"
PY="$(command -v /usr/bin/python3 || command -v python3)"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (use sudo)." >&2; exit 1; }

# CPU wheels are ~2 GB smaller; use CUDA wheels only when an NVIDIA GPU is present.
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  TORCH_INDEX="https://download.pytorch.org/whl/cu128"
else
  TORCH_INDEX="https://download.pytorch.org/whl/cpu"
fi

echo "==> Creating $VENV"
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
# Debian's pip 23.0 can't read PyTorch's package index correctly — upgrade it first.
"$VENV/bin/pip" install -q --upgrade pip setuptools wheel

echo "==> Installing WhisperX (a few minutes, ~2-3 GB download)"
"$VENV/bin/pip" install --no-cache-dir whisperx --extra-index-url "$TORCH_INDEX"

ln -sf "$VENV/bin/whisperx" /usr/local/bin/whisperx
if whisperx --help >/dev/null 2>&1; then
  echo
  echo "WhisperX is installed. In ClipForge choose Advanced → Transcription → WhisperX."
  echo "(Its speech and alignment models download the first time it runs.)"
else
  echo "WhisperX installed but did not start — see the output above." >&2
  exit 1
fi

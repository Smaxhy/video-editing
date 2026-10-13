#!/usr/bin/env bash
# Starts ClipForge in the background every time the codespace starts (see .devcontainer/devcontainer.json).
cd "$(dirname "$0")/.." || exit 1
mkdir -p workspace
# Pick up the latest ClipForge on every start (fast-forward only; never overwrites local edits).
git pull --ff-only --quiet 2>/dev/null && echo "ClipForge is up to date ($(git rev-parse --short HEAD))." || echo "Could not update automatically — continuing with the current version."
if [ -z "${CLIPFORGE_PASSWORD:-}" ] || [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "ClipForge needs the CLIPFORGE_PASSWORD and CLAUDE_CODE_OAUTH_TOKEN Codespaces secrets."
  echo "Add them at https://github.com/settings/codespaces, then restart the codespace."
  exit 0
fi
# Stop a previous copy (e.g. after a restart), then launch detached so it outlives this script.
if [ -f workspace/server.pid ] && kill -0 "$(cat workspace/server.pid)" 2>/dev/null; then
  kill "$(cat workspace/server.pid)" 2>/dev/null || true
  sleep 1
fi
setsid nohup /usr/local/bin/clipforge-entrypoint node src/server.js --lan > workspace/server.log 2>&1 < /dev/null &
echo $! > workspace/server.pid
PID=$(cat workspace/server.pid)
for _ in $(seq 1 30); do
  # Our own process must still be alive — otherwise something else is answering on port 3000.
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "ClipForge failed to start — see workspace/server.log:"
    tail -5 workspace/server.log
    exit 1
  fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/api/auth 2>/dev/null && { echo "ClipForge is running on port 3000 (Ports tab)."; exit 0; }
  sleep 1
done
echo "ClipForge did not start — see workspace/server.log"
exit 1

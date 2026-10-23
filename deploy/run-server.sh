#!/usr/bin/env bash
# Keeps ClipForge running in a codespace: if the server ever stops — a crash, running out of memory,
# or an auto-update that exits so the new version can start — it is started again a few seconds later.
cd "$(dirname "$0")/.." || exit 1
export CLIPFORGE_SUPERVISED=1
fails=0
while true; do
  started=$(date +%s)
  /usr/local/bin/clipforge-entrypoint node src/server.js --lan
  code=$?
  # Back off if it keeps dying right after starting (a broken version or a full disk).
  if [ $(( $(date +%s) - started )) -lt 30 ]; then fails=$((fails + 1)); else fails=0; fi
  delay=$(( fails > 5 ? 60 : 3 ))
  echo "[$(date '+%F %T')] ClipForge stopped (exit code $code) — starting it again in ${delay}s"
  sleep "$delay"
done

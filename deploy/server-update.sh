#!/usr/bin/env bash
# ClipForge auto-update for servers (run every 5 minutes by the clipforge-update systemd timer that
# deploy/install-server.sh sets up). When GitHub has a new version it builds it in the background,
# waits until nothing is rendering, then swaps it in. The app's "Stop everything & update" button
# drops a flag file that skips the wait (and restarts even when there is nothing new).
set -euo pipefail

# Wrapped in a function: bash reads all of it before running, so the git update below can safely
# replace this very file.
main() {
  DIR="${CLIPFORGE_DIR:-/opt/clipforge}"
  BRANCH="${CLIPFORGE_BRANCH:-main}"
  cd "$DIR"
  exec 9>"$DIR/.update.lock"
  flock -n 9 || exit 0 # an update is already running

  FLAG="$DIR/workspace/.update-now"
  forced=0
  [ -f "$FLAG" ] && forced=1 && rm -f "$FLAG"

  git fetch -q origin "$BRANCH"
  new=0
  [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ] && new=1
  [ "$new" = 1 ] || [ "$forced" = 1 ] || exit 0

  # ClipForge writes workspace/activity.json every 20 s: { at, busy } (busy = what's running, or null).
  busy() {
    [ -f "$DIR/workspace/activity.json" ] || return 1
    python3 -c 'import json,sys,time
try: d = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
sys.exit(0 if d.get("busy") and time.time() * 1000 - d.get("at", 0) < 120000 else 1)' "$DIR/workspace/activity.json"
  }

  if [ "$new" = 1 ]; then
    echo "ClipForge: new version $(git rev-parse --short "origin/$BRANCH") — building"
    git reset -q --hard "origin/$BRANCH"
    CLIPFORGE_VERSION=$(git rev-parse --short HEAD) docker compose build -q
  fi
  # Swap in when idle (a forced update doesn't wait). Give up after 3 hours; the next run retries.
  if [ "$forced" = 0 ]; then
    for _ in $(seq 1 180); do
      busy || break
      sleep 60
    done
    busy && { echo "ClipForge: still busy — will retry"; exit 0; }
  fi
  if [ "$new" = 0 ]; then
    docker compose up -d --remove-orphans --force-recreate # forced: restart even with nothing new
  else
    docker compose up -d --remove-orphans
  fi
  install -m 0755 "$DIR/deploy/clipforge-cli.sh" /usr/local/bin/clipforge 2>/dev/null || true
  docker image prune -f >/dev/null 2>&1 || true # old versions' images take gigabytes
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true # and so does old build cache
  echo "ClipForge: running $(git rev-parse --short HEAD)"
}

main "$@"

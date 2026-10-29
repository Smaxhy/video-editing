#!/usr/bin/env bash
# `clipforge` — one command to look after ClipForge on a server (installed to /usr/local/bin by
# deploy/install-server.sh). Run `clipforge help` for the list.
set -euo pipefail

DIR="${CLIPFORGE_DIR:-/opt/clipforge}"
[ -d "$DIR" ] || { echo "ClipForge isn't installed in $DIR."; exit 1; }
cd "$DIR"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run it as root:  sudo clipforge $*"; exit 1; }; }
port() { local p; p=$(env_get CLIPFORGE_PORT); echo "${p:-3000}"; }
url() {
  local host
  host=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
  if [ -n "$host" ]; then echo "https://$host"; else echo "http://<this-server>:$(port)"; fi
}

status() {
  local state up=0
  state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' clipforge 2>/dev/null || echo "not created")
  curl -fsS -o /dev/null "http://127.0.0.1:$(port)/api/auth" 2>/dev/null && up=1
  bold "ClipForge"
  if [ "$up" = 1 ]; then echo "  ✓ running ($state)"; else echo "  ✗ not answering ($state) — try: clipforge restart"; fi
  echo "  version:  $(git rev-parse --short HEAD) ($(git log -1 --format=%cr))"
  echo "  open:     $(url)"
  if [ -f workspace/activity.json ]; then
    python3 -c 'import json,sys,time
d = json.load(open(sys.argv[1]))
busy = d.get("busy") if time.time() * 1000 - d.get("at", 0) < 120000 else None
print("  doing:    " + (busy or "nothing (idle)"))' workspace/activity.json 2>/dev/null || true
  fi
  df -h --output=avail,size "$DIR" | awk 'NR==2 {print "  disk:     " $1 " free of " $2}'
  free -h | awk '/^Mem:/ {print "  memory:   " $7 " free of " $2}'
  systemctl is-active --quiet clipforge-update.timer 2>/dev/null && echo "  updates:  automatic (every 5 minutes, never mid-render)" || echo "  updates:  automatic updates are off — run: sudo bash $DIR/deploy/install-server.sh"
}

cmd="${1:-status}"
case "$cmd" in
  status|"") status ;;
  url|qr)
    echo "$(url)"
    docker exec clipforge node scripts/qr.js "$(url)" 2>/dev/null || true ;;
  password)
    need_root password
    echo "App password: $(env_get CLIPFORGE_PASSWORD)" ;;
  logs) docker compose logs -f --tail "${2:-200}" ;;
  restart)
    need_root restart
    docker compose up -d --remove-orphans >/dev/null
    docker restart clipforge >/dev/null && echo "Restarted." ;;
  stop) need_root stop; docker compose stop && echo "Stopped. Start it again with: clipforge start" ;;
  start) need_root start; docker compose up -d --remove-orphans && echo "Started." ;;
  update)
    need_root update
    mkdir -p workspace && touch workspace/.update-now
    CLIPFORGE_DIR="$DIR" bash "$DIR/deploy/server-update.sh"
    echo "Up to date ($(git rev-parse --short HEAD))." ;;
  login)
    need_root login
    grep -vE '^CLAUDE_CODE_OAUTH_TOKEN=' .env > .env.tmp || true
    cat .env.tmp > .env && rm -f .env.tmp
    echo "Claude login cleared — the installer will ask you to log in again."
    bash "$DIR/deploy/install-server.sh" ;;
  space) docker exec clipforge du -sh /app/library /app/output /app/workspace /app/uploads /root/.cache 2>/dev/null; df -h "$DIR" ;;
  help|-h|--help)
    cat <<'HELP'
clipforge            status: running?, version, link, what it's doing, disk, memory
clipforge url        the link to open on your phone (+ QR code)
clipforge password   show the app password
clipforge logs       live log (Ctrl+C to leave)
clipforge restart    restart ClipForge
clipforge update     install the newest version now (stops a stuck render)
clipforge login      log in to Claude again (when the login expired)
clipforge space      what's using the disk
clipforge stop|start
HELP
    ;;
  *) echo "Unknown command: $cmd  (see: clipforge help)"; exit 1 ;;
esac

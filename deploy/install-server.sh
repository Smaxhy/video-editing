#!/usr/bin/env bash
# ClipForge server installer — sets up everything on a fresh Ubuntu/Debian server (Intel/AMD or ARM):
#   Docker, Git, Tailscale, ClipForge (built in Docker), a password, your Claude login, phone access.
#
#   curl -fsSL https://raw.githubusercontent.com/Smaxhy/video-editing/main/deploy/install-server.sh -o clipforge-install.sh
#   sudo bash clipforge-install.sh
#
# Run it again any time to update ClipForge (your password, login and videos are kept).
# Options (environment variables): CLIPFORGE_DIR (default /opt/clipforge), CLIPFORGE_BRANCH (default main),
#   CLIPFORGE_REPO (default https://github.com/Smaxhy/video-editing.git), SKIP_TAILSCALE=1.
set -euo pipefail

main() {
  local REPO="${CLIPFORGE_REPO:-https://github.com/Smaxhy/video-editing.git}"
  local BRANCH="${CLIPFORGE_BRANCH:-main}"
  local DIR="${CLIPFORGE_DIR:-/opt/clipforge}"

  # Prompts must read from the keyboard even when this script arrives through a pipe.
  if [ ! -t 0 ] && [ -e /dev/tty ]; then exec </dev/tty; fi

  bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
  ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
  warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
  die()  { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

  [ "$(id -u)" -eq 0 ] || die "Run with sudo:  sudo bash $0"
  command -v apt-get >/dev/null || die "This installer supports Ubuntu/Debian. Pick an Ubuntu image for your server."

  bold "1/7  System packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git util-linux python3 >/dev/null
  ok "git, curl"

  # Small servers (≤ 8 GB) get swap so Whisper + Chrome don't run out of memory mid-render.
  local mem_kb; mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -lt 8000000 ] && ! swapon --show | grep -q .; then
    fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "added 4 GB swap (server has $((mem_kb / 1024 / 1024)) GB RAM)"
  fi

  bold "2/7  Docker"
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (systemctl status docker)."
  ok "$(docker --version)"

  bold "3/7  ClipForge code"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch -q origin "$BRANCH"
    git -C "$DIR" checkout -q "$BRANCH"
    git -C "$DIR" reset -q --hard "origin/$BRANCH"
    ok "updated $DIR ($(git -C "$DIR" rev-parse --short HEAD))"
  else
    git clone -q --branch "$BRANCH" "$REPO" "$DIR"
    ok "downloaded to $DIR"
  fi
  cd "$DIR"
  touch .env && chmod 600 .env

  # Read/replace one KEY=value line in .env without ever printing secrets.
  env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
  env_set() {
    local tmp; tmp=$(mktemp)
    grep -vE "^$1=" .env > "$tmp" || true
    printf '%s=%s\n' "$1" "$2" >> "$tmp"
    cat "$tmp" > .env && rm -f "$tmp"
  }

  bold "4/7  Building ClipForge (first time: 10-25 minutes)"
  # Plain `docker build`: `docker compose build` refuses to start until the password and Claude login
  # below are in .env, and the login needs this image. Same image name and build args as docker-compose.yml.
  local whisperx; whisperx=$(env_get WITH_WHISPERX)
  docker build --pull -t clipforge:latest --build-arg "WITH_WHISPERX=${whisperx:-0}" .
  ok "image built"

  bold "5/7  Password + Claude login"
  local NEW_PASSWORD=""
  if [ -z "$(env_get CLIPFORGE_PASSWORD)" ]; then
    NEW_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)
    env_set CLIPFORGE_PASSWORD "$NEW_PASSWORD"
    ok "generated an app password (shown at the end)"
  else
    ok "keeping your existing app password"
  fi

  if [ -z "$(env_get CLAUDE_CODE_OAUTH_TOKEN)" ]; then
    echo
    echo "  ClipForge uses your Claude Pro/Max subscription (never paid API credits)."
    echo "  Next: Claude shows a link. Open it on your phone or PC, log in, and paste the code back here."
    echo
    read -r -p "  Press Enter to start the Claude login… " _
    local log; log=$(mktemp)
    # `script` records the session so the token can be picked up automatically.
    script -q -e -c "docker run --rm -it --entrypoint claude clipforge:latest setup-token" "$log" || true
    local token
    token=$(sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$log" | tr -d '\r' | grep -oE 'sk-ant-oat01-[A-Za-z0-9_-]+' | tail -1 || true)
    shred -u "$log" 2>/dev/null || rm -f "$log"
    if [ -z "$token" ]; then
      echo
      read -r -s -p "  Couldn't read the token automatically — paste it here (input hidden): " token
      echo
    fi
    [[ "$token" == sk-ant-* ]] || die "That doesn't look like a Claude token (it starts with sk-ant-). Run the installer again."
    env_set CLAUDE_CODE_OAUTH_TOKEN "$token"
    ok "Claude login saved"
  else
    ok "keeping your existing Claude login"
  fi

  bold "6/7  Starting ClipForge"
  docker compose up -d --remove-orphans
  local PORT; PORT=$(env_get CLIPFORGE_PORT); PORT=${PORT:-3000}
  for _ in $(seq 1 90); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/auth" 2>/dev/null && break
    sleep 2
  done
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/auth" || die "ClipForge didn't start. See: docker compose -f $DIR/docker-compose.yml logs"
  ok "running (restarts automatically after reboots)"

  local URL="http://<this-server>:3000"
  if [ "${SKIP_TAILSCALE:-0}" != "1" ]; then
    bold "7/7  Phone access with Tailscale (free, private, HTTPS)"
    command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
    if ! tailscale status >/dev/null 2>&1; then
      echo "  Log in to Tailscale: open the link below (same account you'll use on your phone)."
      tailscale up
    fi
    echo "  If Tailscale asks you to enable HTTPS, open its link and click Enable."
    tailscale serve --bg "$PORT" >/dev/null
    local host
    host=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
    URL="https://$host"
    ok "ClipForge is at $URL"
  fi

  # Automatic updates: every 5 minutes, new versions are built and swapped in while nothing renders.
  cat > /etc/systemd/system/clipforge-update.service <<UNIT
[Unit]
Description=ClipForge auto-update
After=docker.service network-online.target

[Service]
Type=oneshot
Environment=CLIPFORGE_DIR=$DIR CLIPFORGE_BRANCH=$BRANCH
ExecStart=/usr/bin/env bash $DIR/deploy/server-update.sh
UNIT
  cat > /etc/systemd/system/clipforge-update.timer <<UNIT
[Unit]
Description=Check for ClipForge updates every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now clipforge-update.timer >/dev/null 2>&1 && ok "automatic updates on (every 5 minutes, never mid-render)" || warn "could not enable automatic updates"
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  install -m 0755 "$DIR/deploy/clipforge-cli.sh" /usr/local/bin/clipforge && ok "added the 'clipforge' command (try: clipforge help)"

  bold "Done!"
  echo
  echo "  On your phone:"
  echo "    1. Install the Tailscale app and log in with the same account."
  echo "    2. Scan this code (or type $URL):"
  echo
  docker exec clipforge node scripts/qr.js "$URL" || true
  echo "    3. iPhone: Share → Add to Home Screen.   Android: ⋮ → Install app."
  echo
  if [ -n "$NEW_PASSWORD" ]; then
    printf '  App password: \033[1m%s\033[0m   (save it — also stored in %s/.env)\n' "$NEW_PASSWORD" "$DIR"
  else
    echo "  App password: unchanged (see CLIPFORGE_PASSWORD in $DIR/.env)"
  fi
  echo "  Updates install themselves. Check on it any time with:  clipforge"
  echo "  (clipforge url · clipforge password · clipforge logs · clipforge update · clipforge help)"
  echo
}

main "$@"

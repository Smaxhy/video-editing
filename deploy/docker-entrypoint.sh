#!/bin/sh
# Point HyperFrames at a headless Chrome that works on this machine.
if [ -z "${PRODUCER_HEADLESS_SHELL_PATH:-}" ]; then
  if [ "$(uname -m)" = "x86_64" ]; then
    # Intel/AMD: use the Chrome build HyperFrames itself pins (downloaded once, then cached).
    for cand in ./node_modules/.bin/hyperframes /app/node_modules/.bin/hyperframes; do
      if [ -x "$cand" ]; then "$cand" browser ensure >/dev/null 2>&1 || true; break; fi
    done
  elif [ -f /opt/browsers/headless-shell-path ]; then
    # ARM: Chrome for Testing has no arm64 build — use the Playwright one baked into the image.
    PRODUCER_HEADLESS_SHELL_PATH="$(cat /opt/browsers/headless-shell-path)"
    HYPERFRAMES_BROWSER_PATH="$PRODUCER_HEADLESS_SHELL_PATH"
    export PRODUCER_HEADLESS_SHELL_PATH HYPERFRAMES_BROWSER_PATH
  fi
fi
exec "$@"

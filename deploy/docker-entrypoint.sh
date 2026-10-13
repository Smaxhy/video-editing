#!/bin/sh
# Point HyperFrames at the arch-native headless Chrome installed in the image.
if [ -z "${PRODUCER_HEADLESS_SHELL_PATH:-}" ] && [ -f /opt/browsers/headless-shell-path ]; then
  PRODUCER_HEADLESS_SHELL_PATH="$(cat /opt/browsers/headless-shell-path)"
  HYPERFRAMES_BROWSER_PATH="$PRODUCER_HEADLESS_SHELL_PATH"
  export PRODUCER_HEADLESS_SHELL_PATH HYPERFRAMES_BROWSER_PATH
fi
exec "$@"

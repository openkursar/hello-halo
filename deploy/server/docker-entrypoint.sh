#!/bin/sh
set -e

# With a data directory configured (normally a mounted volume), keep the app's
# own data there too — global skills, the AI engine's conversation records and
# the built-in browser profile live under HOME, not under HALO_DATA_DIR.
if [ -n "$HALO_DATA_DIR" ] && [ "$HOME" = "/tmp" ]; then
  export HOME="$HALO_DATA_DIR/home"
  mkdir -p "$HOME"
fi

# A library the base image lacks would otherwise surface as an opaque crash.
missing=$(ldd /app/linux-unpacked/halo 2>/dev/null | grep 'not found' || true)
if [ -n "$missing" ]; then
  echo "[halo-entrypoint] missing shared libraries:" >&2
  echo "$missing" >&2
fi

exec /app/linux-unpacked/halo --disable-dev-shm-usage "$@"

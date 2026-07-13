#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-server-halo.sh — build the Halo Server deploy bundle.
#
# Halo Server is a standalone, brand-neutral, on-demand build — decoupled from
# the desktop client release cadence. It ALWAYS uses server.product.json (the
# server profile: API-key auth only, no interactive OAuth that can't work
# headless), regardless of which client brand happens to be configured. So this
# one command produces a single universal server image for everyone.
#
# Run on demand (not part of any client build):
#   npm run build:server
#   # or: bash scripts/build-server-halo.sh [OUTPUT_REPO_DIR]
#
# It cross-builds the linux-x64 headless app, compresses it, and splits it into
# <90MB parts inside the halo-server repo's bundle/ directory (so it survives git
# host per-file size limits and rebuilds offline in the container).
#
# Env:
#   ELECTRON_MIRROR                  electron download mirror (recommended in CN)
#   ELECTRON_BUILDER_BINARIES_MIRROR electron-builder tools mirror
#   SKIP_NPM_BUILD=1                 reuse an existing out/ (skip electron-vite build)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_REPO="${1:-$PROJECT_ROOT/../halo-server}"
PART_SIZE="${PART_SIZE:-90m}"

cd "$PROJECT_ROOT"

log() { printf '\033[34m[build-server]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[build-server][ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f server.product.json ] || die "server.product.json not found at repo root"
[ -d "$OUT_REPO" ] || die "output repo not found: $OUT_REPO"
[ -f "$OUT_REPO/Dockerfile" ] || die "$OUT_REPO does not look like the halo-server repo (no Dockerfile)"

# Swap in the server profile, and ALWAYS restore the original product.json on exit
# (success, failure, or interrupt) so the working tree is never left modified.
log "activating server.product.json (brand-neutral, API-key only)..."
RESTORE_PRODUCT=0
if [ -f product.json ]; then
  cp product.json .product.json.bak
  RESTORE_PRODUCT=1
fi
restore_product() {
  if [ "$RESTORE_PRODUCT" = "1" ]; then
    mv .product.json.bak product.json
  else
    rm -f product.json
  fi
}
trap restore_product EXIT
cp server.product.json product.json

# 1) Ensure linux native binaries are present (better-sqlite3 electron prebuild,
#    @parcel/watcher-linux, codex-linux, cloudflared-linux).
log "preparing linux native binaries..."
node scripts/prepare-binaries.mjs --platform linux

# 2) Build the app (main/preload/renderer).
if [ "${SKIP_NPM_BUILD:-}" = "1" ] && [ -f out/main/index.mjs ]; then
  log "SKIP_NPM_BUILD=1 — reusing existing out/"
else
  log "building app (electron-vite)..."
  npm run build
fi
[ -f out/main/index.mjs ] || die "build produced no out/main/index.mjs"

# 3) Cross-build the linux-x64 unpacked app (afterPack swaps in linux natives).
log "packaging linux-x64 (electron-builder)..."
rm -rf dist/linux-unpacked
node_modules/.bin/electron-builder --linux dir --x64
[ -x dist/linux-unpacked/halo ] || die "electron-builder produced no dist/linux-unpacked/halo"

# 4) Compress + split into the repo's bundle/.
log "compressing + splitting bundle into $OUT_REPO/bundle/ ..."
TMP_TGZ="$(mktemp -t halo-bundle.XXXXXX).tgz"
tar czf "$TMP_TGZ" -C dist linux-unpacked

rm -f "$OUT_REPO"/bundle/halo-bundle.tgz.part-*
mkdir -p "$OUT_REPO/bundle"
split -b "$PART_SIZE" "$TMP_TGZ" "$OUT_REPO/bundle/halo-bundle.tgz.part-"

# 5) Integrity check: reassembled size must match.
orig_size=$(wc -c < "$TMP_TGZ")
joined_size=$(cat "$OUT_REPO"/bundle/halo-bundle.tgz.part-* | wc -c)
rm -f "$TMP_TGZ"
[ "$orig_size" = "$joined_size" ] || die "split integrity check failed ($orig_size != $joined_size)"

log "done. bundle parts:"
ls -lh "$OUT_REPO"/bundle/ | awk 'NR>1 {print "  " $5 "  " $9}'
log "compressed size: $(echo "$orig_size" | awk '{printf "%.0f MB\n", $1/1024/1024}')"
log "next: cd $OUT_REPO && git add bundle && git commit && git push"

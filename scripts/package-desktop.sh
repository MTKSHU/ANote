#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
if [[ ! -x node_modules/.bin/tsc ]]; then
  docker run --rm --memory=2300m --cpus=2 -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 -v "$task_root:/workspace" -w /workspace node:22-bookworm npm ci --no-audit --no-fund
fi
docker run --rm --memory=2300m --cpus=2 -v "$task_root:/workspace" -e ANOTE_RELEASE_CHANNEL -e VITE_ANOTE_SERVER_URL="${VITE_ANOTE_SERVER_URL:-}" -w /workspace node:22-bookworm env NODE_OPTIONS=--max-old-space-size=1400 GOMAXPROCS=2 npm run build:desktop
docker run --rm --init --memory=2300m --cpus=2 -v "$task_root:/workspace" -v anote-electron-downloads:/root/.cache/electron -e ANOTE_INCLUDE_LEGACY_BRIDGES -e DESKTOP_TARGETS -e ANOTE_DESKTOP_OUTPUT -e ANOTE_DESKTOP_STAGE -e ANOTE_RELEASE_CHANNEL -e VITE_ANOTE_SERVER_URL="${VITE_ANOTE_SERVER_URL:-}" -w /workspace node:22-bookworm node scripts/package-desktop.mjs

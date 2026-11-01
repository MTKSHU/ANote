#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
if [[ ! -x node_modules/.bin/tsc ]]; then
  docker run --rm -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 -v "$task_root:/workspace" -w /workspace node:22-bookworm npm ci --no-audit --no-fund
fi
docker run --rm -v "$task_root:/workspace" -e VITE_ANOTE_SERVER_URL="${VITE_ANOTE_SERVER_URL:-}" -w /workspace node:22-bookworm npm run build:desktop
docker run --rm --init -v "$task_root:/workspace" -v anote-electron-downloads:/root/.cache/electron -e DESKTOP_TARGETS -w /workspace node:22-bookworm node scripts/package-desktop.mjs

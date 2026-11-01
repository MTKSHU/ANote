#!/usr/bin/env bash
# The TrueNAS host orchestrates Docker; all program execution stays in containers.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
bash validation/scripts/validate.sh
docker run --rm -v "$task_root:/workspace" -v anote-electron-downloads:/root/.cache/electron -w /workspace node:22-bookworm node node_modules/electron/install.js
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm npm run build:desktop
docker build -f apps/desktop/Dockerfile.test -t anote-desktop-test:local .
docker run --rm --init --network anote-validation_default --env-file validation/.env -e BASE_URL=http://anote-validation.internal:3000 -v "$task_root:/workspace" -w /workspace anote-desktop-test:local xvfb-run -a npm run test:desktop
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node scripts/desktop-report.mjs

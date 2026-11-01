#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
if [[ "${ANOTE_SKIP_DEPS:-0}" != "1" ]]; then
  docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm npm ci --no-audit --no-fund
fi
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node deploy/init-env.mjs
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test)
"${compose[@]}" build api
docker build -f validation/Dockerfile.browser -t anote-validation-browser:local .
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --force-recreate --wait api
docker run --rm --init --ipc=host --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root:/workspace" -w /workspace anote-validation-browser:local node_modules/.bin/playwright test --config apps/web/playwright.config.ts

#!/usr/bin/env bash
# The host only orchestrates Docker. Dependencies, builds, runtimes and tests stay in containers.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
compose=(docker compose --env-file validation/.env -f validation/compose.yaml -p anote-validation)

docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node validation/scripts/init-env.mjs
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm npm ci --no-audit --no-fund
mkdir -p validation/artifacts
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm npm run test:unit | tee validation/artifacts/unit-results.txt
"${compose[@]}" build app e2e
"${compose[@]}" up -d --no-build --force-recreate app
"${compose[@]}" run --rm --no-deps e2e

# Graceful restart of both services preserves the named PostgreSQL volume.
"${compose[@]}" stop app
"${compose[@]}" restart db
"${compose[@]}" up -d --no-build app
"${compose[@]}" run --rm --no-deps -e PERSISTENCE_ONLY=1 e2e
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node validation/scripts/summarize.mjs

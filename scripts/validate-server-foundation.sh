#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node deploy/init-env.mjs
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test)
"${compose[@]}" build api
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --force-recreate --wait api
mkdir -p artifacts/server
docker run --rm --init --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root:/workspace" -w /workspace node:22-bookworm node --test apps/api/tests/foundation.test.mjs | tee artifacts/server/foundation-results.txt
"${compose[@]}" stop api
"${compose[@]}" restart db
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --wait
docker run --rm --init --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -e PERSISTENCE_ONLY=1 -v "$task_root:/workspace" -w /workspace node:22-bookworm node --test apps/api/tests/foundation.test.mjs | tee artifacts/server/persistence-results.txt

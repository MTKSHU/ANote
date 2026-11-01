#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node deploy/init-env.mjs
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test)
"${compose[@]}" build api
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --force-recreate --wait api
mkdir -p artifacts/server
task_api_image="$("${compose[@]}" images -q api)"
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root/artifacts/server:/workspace/artifacts/server" "$task_api_image" node --test apps/api/tests/documents.test.mjs | tee artifacts/server/documents-results.txt
"${compose[@]}" stop api
"${compose[@]}" restart db
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --wait api
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root/artifacts/server:/workspace/artifacts/server" "$task_api_image" node --test apps/api/tests/documents-persistence.test.mjs | tee artifacts/server/documents-persistence-results.txt

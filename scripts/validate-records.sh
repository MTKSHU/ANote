#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test)
"${compose[@]}" build api
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --force-recreate --wait api
task_api_image="$("${compose[@]}" images -q api)"
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root/artifacts/server:/workspace/artifacts/server" "$task_api_image" node --test apps/api/tests/records.test.mjs | tee artifacts/server/records-results.txt
"${compose[@]}" stop api worker
"${compose[@]}" restart db
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --wait api worker
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -e RECORD_PHASE=restart -v "$task_root/artifacts/server:/workspace/artifacts/server" "$task_api_image" node --test apps/api/tests/records.test.mjs | tee artifacts/server/records-restart-results.txt

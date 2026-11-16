#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
task_network=anote-054-preview_default
task_image=anote-desktop-test:local
task_output="$task_root/validation/artifacts/054/history-state-tests.txt"

# This runner never reads deployment env files or attaches production networks.
# Each DB test creates and drops its own database on the 054 QA PostgreSQL.
docker network inspect "$task_network" >/dev/null
for task_file in history-state-store history-state-worker document-worker-queue documents; do
  test -f "$task_root/apps/api/dist/$task_file.js" || { echo "Missing API dist/$task_file.js; compile API in Docker first." >&2; exit 1; }
done
mkdir -p "$(dirname "$task_output")"
docker run --rm --init --name anote-054-history-tests \
  --network "$task_network" --memory=1536m --memory-swap=1536m --cpus=2 --pids-limit=192 \
  --read-only --tmpfs /tmp:rw,size=128m \
  -e ANOTE_ISOLATED_TESTS=1 -e DB_PASSWORD=anote-054-isolated-db -e DATABASE_URL= \
  -e ANOTE_HISTORY_MIGRATE_LEGACY=0 -e ANOTE_HISTORY_ALLOW_LEGACY_RELEASE=0 \
  -v "$task_root:/workspace:ro" -w /workspace "$task_image" \
  node --import tsx --test --test-concurrency=1 \
  validation/tests/history-state-codec-054.test.ts \
  validation/tests/history-state-queue-054.test.ts \
  validation/tests/history-state-store-054.test.mjs \
  validation/tests/history-editors.test.mjs 2>&1 | tee "$task_output"

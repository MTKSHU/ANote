#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
bash scripts/validate-desktop.sh
mkdir -p artifacts/server
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node --import tsx --test apps/api/tests/origin.test.ts | tee artifacts/server/origin-results.txt
bash scripts/validate-server-foundation.sh
bash scripts/validate-server-documents.sh
bash scripts/validate-resources.sh
bash scripts/validate-records.sh
docker run --rm --init --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root:/workspace" -w /workspace node:22-bookworm node --test apps/api/tests/privacy.test.mjs | tee artifacts/server/privacy-results.txt
docker run --rm --init --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root:/workspace" -w /workspace node:22-bookworm node --test apps/api/tests/hierarchy.test.mjs | tee artifacts/server/hierarchy-api-results.txt
ANOTE_SKIP_DEPS=1 bash scripts/validate-web.sh
docker run --rm --init --network anote-test_default --env-file deploy/.env -e FORMAL_API=1 -e BASE_URL=http://anote.internal:3000 -v "$task_root:/workspace" -w /workspace anote-desktop-test:local xvfb-run -a npm run test:desktop
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node scripts/desktop-report.mjs

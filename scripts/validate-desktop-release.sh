#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
bash scripts/package-desktop.sh
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node deploy/init-env.mjs
docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test build api
docker build -f validation/Dockerfile.browser -t anote-validation-browser:local .
docker build -f apps/desktop/Dockerfile.test -t anote-desktop-test:local .
mkdir -p artifacts/web artifacts/deployment
restore_test_api() {
  ANOTE_PORT="${ANOTE_TEST_PORT:-3101}" docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test up -d --no-build --no-deps --force-recreate --wait api
}
trap restore_test_api EXIT
ANOTE_PORT="${ANOTE_TEST_PORT:-3101}" docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.client-test.yaml -p anote-test up -d --no-build --wait api
# Generate the current web layout baseline before comparing the packaged UI.
docker run --rm --init --ipc=host --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root:/workspace" -w /workspace anote-validation-browser:local node_modules/.bin/playwright test --config apps/web/playwright.config.ts ui-consistency.spec.ts --grep '首页、团队和设置的标题'
docker run --rm --init --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -e PACKAGED_CLIENT=1 -v "$task_root:/workspace" -w /workspace anote-desktop-test:local xvfb-run -a npm run test:desktop
docker run --rm --init --ipc=host --network none -e PERSONAL_PACKAGED=1 -v "$task_root:/workspace" -w /workspace anote-desktop-test:local xvfb-run -a node_modules/.bin/playwright test --config apps/desktop/playwright.personal.config.ts
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root/deploy:/workspace/deploy:ro" -v "$task_root/artifacts:/workspace/artifacts" anote-test-api node deploy/verify-clients.mjs
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node scripts/desktop-release-report.mjs

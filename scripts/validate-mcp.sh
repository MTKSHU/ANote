#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
if [[ "${ANOTE_SKIP_DEPS:-0}" != 1 ]]; then
  docker run --rm -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 -v "$task_root:/workspace" -w /workspace node:22-bookworm npm ci --no-audit --no-fund
fi
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node deploy/init-env.mjs
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm npm run build:packages
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node --input-type=module -e 'import fs from "node:fs/promises"; await fs.mkdir("artifacts/server/fixtures",{recursive:true}); if(!await fs.stat("artifacts/server/fixtures/sample.png").catch(()=>null))await fs.writeFile("artifacts/server/fixtures/sample.png",Buffer.from(await fs.readFile("validation/fixtures/mcp-sample.png.b64","utf8"),"base64"));'
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.mcp-test.yaml -p anote-test)
"${compose[@]}" build api
docker build -f validation/Dockerfile.browser -t anote-validation-browser:local .
restore_test_api() {
  "${compose[@]}" rm -sf casdoor-mock
  ANOTE_PORT=3101 docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test up -d --no-build --no-deps --force-recreate --wait api
}
trap restore_test_api EXIT
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --force-recreate --wait api casdoor-mock
docker run --rm --network anote-test_default anote-test-api node --input-type=module -e 'import assert from "node:assert/strict"; const base="http://anote.internal:3000"; const config=await fetch(base+"/api/platform/public").then(r=>r.json()); assert.equal(config.public_origin,base,"Use an isolated test database with the test public origin"); assert.equal((await fetch(base+"/api/auth/providers").then(r=>r.json())).local,true,"Tests require isolated local accounts");'
docker run --rm -v "$task_root:/workspace" -w /workspace node:22-bookworm node --import tsx --test validation/tests/mcp-model.test.ts validation/tests/merge.test.ts | tee artifacts/server/mcp-model-results.txt
docker run --rm --init --ipc=host --network anote-test_default --env-file deploy/.env -e CASDOOR_TEST=1 -e BASE_URL=http://anote.internal:3000 -v "$task_root:/workspace" -w /workspace anote-validation-browser:local node_modules/.bin/playwright test --config apps/web/playwright.config.ts mcp.spec.ts mcp-oidc.spec.ts

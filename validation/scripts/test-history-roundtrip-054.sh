#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
task_id="$(date +%s)_$$"
task_source="anote054_history_source_$task_id"
task_restored="anote054_history_restored_$task_id"
task_api="anote-054-old-api-${task_id//_/-}"
task_network=anote-054-preview_default
task_db_container=anote-054-preview-db-1
task_origin="http://$task_api:3000"
task_image_id=sha256:3a1960a504f5b254c1b1136a600cb78213f5982413abb9095328d74eb0a76068
task_dump="/tmp/anote054_history_$task_id.dump"
task_evidence="$(mktemp -d)"
task_results="$task_root/validation/artifacts/054"
mkdir -p "$task_results"

pg(){ docker exec -e PGPASSWORD=anote-054-isolated-db "$task_db_container" "$@"; }
run_node(){
  docker run --rm --init --network "$task_network" --memory=1024m --memory-swap=1024m --cpus=1 --pids-limit=192 \
    --read-only --tmpfs /tmp:rw,size=64m \
    -e ANOTE_ISOLATED_TESTS=1 -e "DATABASE_URL=postgres://anote:anote-054-isolated-db@db:5432/$task_database" \
    -e "ANOTE_OLD_API_ORIGIN=$task_origin" -e "ANOTE_OLD_API_IMAGE_ID=$task_image_id" \
    -e "ANOTE_RUN_EXIT=${task_status:-1}" -e "ANOTE_CONTAINER_REMOVED=${task_container_removed:-0}" \
    -e "ANOTE_SOURCE_REMOVED=${task_source_removed:-0}" -e "ANOTE_RESTORED_REMOVED=${task_restored_removed:-0}" -e "ANOTE_DUMP_REMOVED=${task_dump_removed:-0}" \
    -v "$task_root:/workspace:ro" -v "$task_evidence:/evidence" -v "$task_results:/results" -w /workspace \
    anote-desktop-test:local node validation/scripts/history-state-roundtrip-054.mjs "$1"
}
cleanup(){
  task_status=$?
  trap - EXIT
  task_container_removed=0; task_source_removed=0; task_restored_removed=0; task_dump_removed=0
  docker rm -f "$task_api" >/dev/null 2>&1 || true
  if ! docker container inspect "$task_api" >/dev/null 2>&1; then task_container_removed=1; fi
  if pg dropdb -h 127.0.0.1 -U anote --if-exists --force "$task_source"; then task_source_removed=1; fi
  if pg dropdb -h 127.0.0.1 -U anote --if-exists --force "$task_restored"; then task_restored_removed=1; fi
  if docker exec "$task_db_container" rm -f "$task_dump"; then task_dump_removed=1; fi
  if [[ "$task_container_removed$task_source_removed$task_restored_removed$task_dump_removed" != 1111 ]]; then task_status=1; fi
  task_database="$task_restored"
  run_node evidence || task_status=1
  rm -rf "$task_evidence"
  exit "$task_status"
}
trap cleanup EXIT

test "$(docker image inspect simplenote-api:0.5.3 --format '{{.Id}}')" = "$task_image_id"
docker network inspect "$task_network" >/dev/null
pg createdb -h 127.0.0.1 -U anote "$task_source"
pg createdb -h 127.0.0.1 -U anote "$task_restored"
task_database="$task_source"; run_node seed
pg pg_dump -h 127.0.0.1 -U anote --format=custom --file="$task_dump" "$task_source"
pg pg_restore -h 127.0.0.1 -U anote --exit-on-error --no-owner --dbname="$task_restored" "$task_dump"
task_dump_bytes="$(docker exec "$task_db_container" stat -c %s "$task_dump")"
read -r task_dump_sha256 task_ignored <<<"$(docker exec "$task_db_container" sha256sum "$task_dump")"
printf '%s %s\n' "$task_dump_bytes" "$task_dump_sha256" >"$task_evidence/dump.txt"
task_database="$task_restored"; run_node verify-restored

# Keep the immutable old backend isolated: no host ports, production volumes,
# compacted encoding-2 documents or deployment env files are used.
docker run -d --init --name "$task_api" --network "$task_network" --memory=768m --memory-swap=768m --cpus=1 --pids-limit=192 \
  --read-only --tmpfs /tmp:rw,size=64m --tmpfs /data/resources:rw,size=64m,mode=1777 \
  -e "DATABASE_URL=postgres://anote:anote-054-isolated-db@db:5432/$task_restored" \
  -e PORT=3000 -e "PUBLIC_ORIGIN=$task_origin" -e ASSET_ROOT=/data/resources -e NODE_ENV=test -e COOKIE_SECURE=false \
  -e SETTINGS_ENCRYPTION_KEY=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  -e CASDOOR_SERVER_URL= -e CASDOOR_CLIENT_ID= -e CASDOOR_CLIENT_SECRET= -e CASDOOR_APPLICATION= \
  -e MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true "$task_image_id" >/dev/null
run_node old-http

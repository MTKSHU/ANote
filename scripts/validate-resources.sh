#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
mkdir -p artifacts/server/fixtures
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote-test)
"${compose[@]}" build api worker
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --force-recreate --wait api worker
task_api_image="$("${compose[@]}" images -q api)"
task_worker_image="$("${compose[@]}" images -q worker)"
docker run --rm --user 0:0 -v "$task_root/artifacts/server/fixtures:/fixtures" "$task_worker_image" ffmpeg -nostdin -v error -f lavfi -i testsrc2=size=320x240:rate=15 -t 2 -c:v libx264 -pix_fmt yuv420p -threads 1 -y /fixtures/sample.mp4
docker run --rm --user 0:0 -v "$task_root/artifacts/server/fixtures:/fixtures" "$task_worker_image" ffmpeg -nostdin -v error -f lavfi -i sine=frequency=440:duration=2 -y /fixtures/sample.wav
docker run --rm --user 0:0 -v "$task_root/artifacts/server/fixtures:/fixtures" "$task_worker_image" ffmpeg -nostdin -v error -f lavfi -i color=c=green:size=64x64 -frames:v 1 -threads 1 -y /fixtures/sample.png
docker run --rm --user 0:0 -v "$task_root/artifacts/server/fixtures:/fixtures" "$task_worker_image" ffmpeg -nostdin -v error -f lavfi -i color=c=red:size=96x48 -frames:v 1 -threads 1 -y /fixtures/wide.png
docker run --rm --user 0:0 -v "$task_root/artifacts/server/fixtures:/fixtures" "$task_worker_image" ffmpeg -nostdin -v error -f lavfi -i color=c=blue:size=48x96 -frames:v 1 -threads 1 -y /fixtures/tall.png
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root/artifacts/server:/workspace/artifacts/server" "$task_api_image" node --test apps/api/tests/resources.test.mjs | tee artifacts/server/resources-results.txt
"${compose[@]}" stop api worker
"${compose[@]}" restart db
ANOTE_PORT=3101 "${compose[@]}" up -d --no-build --wait api worker
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -e RESOURCE_PHASE=resume -v "$task_root/artifacts/server:/workspace/artifacts/server" "$task_api_image" node --test apps/api/tests/resources.test.mjs | tee artifacts/server/resources-restart-results.txt
docker run --rm --init --user 0:0 --network anote-test_default --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 -v "$task_root/artifacts/server:/workspace/artifacts/server" "$task_api_image" node --test apps/api/tests/capacity.test.mjs | tee artifacts/server/capacity-results.txt

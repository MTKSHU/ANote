#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
docker compose --env-file deploy/.env --env-file deploy/.env.nas -f deploy/compose.yaml -f deploy/compose.nas.yaml -p "${ANOTE_COMPOSE_PROJECT:-anote}" "$@"

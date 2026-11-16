#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export ANOTE_DESKTOP_OUTPUT="${ANOTE_DESKTOP_OUTPUT:-artifacts/preview/desktop/releases}"
export ANOTE_DESKTOP_STAGE="${ANOTE_DESKTOP_STAGE:-.work/desktop-package-preview}"
export ANOTE_RELEASE_CHANNEL=preview
export VITE_ANOTE_SERVER_URL="${VITE_ANOTE_SERVER_URL:-}"
exec bash "$task_root/scripts/package-desktop.sh"

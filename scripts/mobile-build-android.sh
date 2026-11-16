#!/usr/bin/env bash
# Everything including SDK/JDK/Gradle is installed and executed inside Docker.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_dir/scripts/mobile-build-common.sh"
preview_origin="${MOBILE_PREVIEW_ORIGIN:-}"
mkdir -p "$output_dir"
docker build -f "$repo_dir/apps/mobile/tools/Dockerfile.android" -t "anote-mobile-android-builder:$mobile_version" "$repo_dir/apps/mobile"
docker run --rm --memory=3g --cpus=2 \
  --mount "type=bind,src=$repo_dir/apps/mobile/android,dst=/source,readonly" \
  --mount "type=bind,src=$output_dir,dst=/artifacts" \
  --mount type=volume,src=anote-mobile-gradle-050,dst=/root/.gradle \
  --mount type=volume,src=anote-mobile-android-preview-signing-050,dst=/root/.android \
  -e "PREVIEW_ORIGIN=$preview_origin" -e "APP_VERSION=$mobile_version" -e "APP_VERSION_CODE=$mobile_version_code" "anote-mobile-android-builder:$mobile_version"

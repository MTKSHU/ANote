#!/usr/bin/env bash
# Source this from a mobile build wrapper. Node and version synchronization run
# in Docker, sharing the desktop package as the release version source.
read -r mobile_version mobile_version_code < <(docker run --rm --memory=128m --cpus=0.5 \
  --mount "type=bind,src=$repo_dir,dst=/workspace" -w /workspace \
  node:22-bookworm node scripts/sync-mobile-version.mjs --print)
if [[ ! "$mobile_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$mobile_version_code" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'Could not derive the mobile version from the desktop release' >&2
  exit 1
fi
output_dir="${MOBILE_OUTPUT_DIR:-$repo_dir/artifacts/mobile/$mobile_version}"
mkdir -p "$output_dir"
docker run --rm --memory=128m --cpus=0.5 \
  --mount "type=bind,src=$repo_dir,dst=/workspace,readonly" \
  --mount "type=bind,src=$output_dir,dst=/artifacts" -w /workspace \
  node:22-bookworm node scripts/sync-mobile-version.mjs --prepare /artifacts

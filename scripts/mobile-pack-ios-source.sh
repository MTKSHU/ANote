#!/usr/bin/env bash
# Archives the uncompiled Xcode sources. This does not create or claim an IPA.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_dir/scripts/mobile-build-common.sh"
mkdir -p "$output_dir"
docker run --rm --memory=128m --cpus=0.5 --entrypoint /bin/sh \
  --mount "type=bind,src=$repo_dir/apps/mobile/ios,dst=/source/ios,readonly" \
  --mount "type=bind,src=$repo_dir/docs/mobile-clients.md,dst=/source/mobile-clients.md,readonly" \
  --mount "type=bind,src=$output_dir,dst=/artifacts" -e "APP_VERSION=$mobile_version" node:22-bookworm -c '
    set -eu
    tar -czf /artifacts/.ios-source.tmp -C /source \
      ios/ANote/AppDelegate.swift ios/ANote/ANoteViewController.swift \
      ios/ANote/Info.plist ios/ANote/Info.Debug.plist ios/ANote/Assets.xcassets \
      ios/ANote.xcodeproj/project.pbxproj \
      ios/ANote.xcodeproj/xcshareddata/xcschemes/ANote.xcscheme mobile-clients.md -C /artifacts mobile-version.json
    mv /artifacts/.ios-source.tmp "/artifacts/ANote-${APP_VERSION}-ios-source.tar.gz"
    cd /artifacts
    sha256sum "ANote-${APP_VERSION}-ios-source.tar.gz" > ios-source-SHA256SUMS
    for checksum in android-SHA256SUMS harmonyos-SHA256SUMS ios-source-SHA256SUMS; do
      if [ -f "$checksum" ]; then cat "$checksum"; fi
    done > .SHA256SUMS.tmp
    mv .SHA256SUMS.tmp SHA256SUMS
  '
echo 'iOS source archive created. No IPA has been compiled; macOS / Xcode validation is still required.'

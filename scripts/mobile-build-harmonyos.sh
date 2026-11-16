#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_dir/scripts/mobile-build-common.sh"
preview_origin="${MOBILE_PREVIEW_ORIGIN:-}"
mkdir -p "$output_dir"
# Only Huawei's public mirror is used. Pin archive and verify vendor SHA256.
docker run --rm --mount type=volume,src=anote-mobile-harmony-tools-510,dst=/opt/harmony node:22-bookworm bash -lc '
  set -euo pipefail
  if [[ ! -x /opt/harmony/command-line-tools/bin/hvigorw ]]; then
    cd /opt/harmony
    curl --retry 4 --retry-all-errors --retry-delay 2 -fsSL https://repo.huaweicloud.com/harmonyos/ohpm/5.1.0/commandline-tools-linux-x64-5.1.0.840.zip -o commandline.zip
    echo "1dcefa4741dc289277560b2802040e0c45b433898d8db453d711d5376e0478f1  commandline.zip" | sha256sum -c -
    unzip -q commandline.zip
    rm commandline.zip
  fi
'
docker build -f "$repo_dir/apps/mobile/tools/Dockerfile.harmonyos" -t "anote-mobile-harmonyos-builder:$mobile_version" "$repo_dir/apps/mobile"
docker run --rm --memory=3g --cpus=2 \
  --mount "type=bind,src=$repo_dir/apps/mobile/harmonyos,dst=/source,readonly" \
  --mount "type=bind,src=$output_dir,dst=/artifacts" \
  --mount type=volume,src=anote-mobile-harmony-tools-510,dst=/opt/harmony,readonly \
  --mount type=volume,src=anote-mobile-hvigor-050,dst=/root/.hvigor \
  --mount type=volume,src=anote-mobile-ohpm-050,dst=/root/.ohpm \
  -e "PREVIEW_ORIGIN=$preview_origin" -e "APP_VERSION=$mobile_version" -e "APP_VERSION_CODE=$mobile_version_code" "anote-mobile-harmonyos-builder:$mobile_version"

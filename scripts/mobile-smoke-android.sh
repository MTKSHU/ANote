#!/usr/bin/env bash
# Real API 35 emulator installation and first-launch / preview-connect smoke test.
# Optional isolated account fixture: MOBILE_TEST_FIXTURE=/absolute/path/to/test-fixture.json
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_dir/scripts/mobile-build-common.sh"
container_name="anote-mobile-smoke-${mobile_version//./}-$$"
if [[ ! -c /dev/kvm ]]; then
  echo 'Android emulator smoke test requires /dev/kvm; APK compilation does not.' >&2
  exit 1
fi
if [[ ! -f "$output_dir/ANote-${mobile_version}-android-preview.apk" ]]; then
  echo 'Build the preview APK before the emulator smoke test.' >&2
  exit 1
fi
docker build --build-arg "BUILDER_VERSION=$mobile_version" -f "$repo_dir/apps/mobile/tools/Dockerfile.android-emulator" -t "anote-mobile-android-emulator:$mobile_version" "$repo_dir/apps/mobile"
docker run --rm -d --name "$container_name" --memory=3g --memory-swap=3g --cpus=2 --device=/dev/kvm --shm-size=1g \
  --mount "type=bind,src=$output_dir,dst=/artifacts" \
  --mount "type=bind,src=$repo_dir/apps/mobile/tools,dst=/mobile-tools,readonly" \
  "anote-mobile-android-emulator:$mobile_version" -c \
  'exec /opt/android-sdk/emulator/emulator -avd anote050 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -memory 2048 -cores 2 -accel on' >/dev/null
trap 'docker stop --timeout 10 "$container_name" >/dev/null 2>&1 || true' EXIT
smoke_args=()
if [[ -n "${MOBILE_TEST_FIXTURE:-}" ]]; then
  docker cp "$MOBILE_TEST_FIXTURE" "$container_name:/tmp/anote-mobile-fixture.json"
  smoke_args+=(--login)
fi
docker exec "$container_name" node /mobile-tools/android-smoke.mjs "${smoke_args[@]}"

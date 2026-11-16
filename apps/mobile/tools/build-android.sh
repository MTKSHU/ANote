#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work /artifacts
cp -a /source/. /work/
cd /work
: "${APP_VERSION:?Mobile release version is required}"
: "${APP_VERSION_CODE:?Mobile build number is required}"
export MOBILE_APK="ANote-${APP_VERSION}-android-preview.apk"
gradle --no-daemon --console=plain -PpreviewOrigin="${PREVIEW_ORIGIN:-}" :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
artifact="/artifacts/$MOBILE_APK"
cp app/build/outputs/apk/debug/app-debug.apk "$artifact"
/opt/android-sdk/build-tools/35.0.0/apksigner verify --verbose "$artifact" > /artifacts/android-apksigner.txt
/opt/android-sdk/build-tools/35.0.0/aapt dump badging "$artifact" > /artifacts/android-package.txt
node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const metadata=fs.readFileSync('/artifacts/android-package.txt','utf8');
assert(metadata.includes(`versionCode='${process.env.APP_VERSION_CODE}'`));
assert(metadata.includes(`versionName='${process.env.APP_VERSION}'`));
assert(metadata.includes("name='cn.anote.mobile.preview'"));
JS
cp app/build/reports/lint-results-debug.html /artifacts/android-lint.html
# Replace this generated report directory so repeated builds cannot leave a
# previous test report at the root and nest the new report one level below it.
rm -rf /artifacts/android-unit-tests
cp -a app/build/test-results/testDebugUnitTest /artifacts/android-unit-tests
cd /artifacts
sha256sum "$MOBILE_APK" > android-SHA256SUMS

#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work /artifacts
cp -a /source/. /work/
cd /work
: "${APP_VERSION:?Mobile release version is required}"
: "${APP_VERSION_CODE:?Mobile build number is required}"
node --input-type=module <<'JS'
import fs from 'node:fs';
const origin=process.env.PREVIEW_ORIGIN || '';
if (origin) {
  const parsed=new URL(origin);
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname!=='/' || parsed.search || parsed.hash) throw new Error('PREVIEW_ORIGIN must be one HTTP(S) origin');
}
fs.writeFileSync('entry/src/main/ets/common/Preview.ets', `export const PREVIEW_ORIGIN: string = ${JSON.stringify(origin)};\n`);
fs.writeFileSync('local.properties', `sdk.dir=${process.env.HARMONY_TOOLS}/sdk\n`);
JS
export DEVECO_SDK_HOME="$HARMONY_TOOLS/sdk"
export DEVECO_NODE_HOME="$HARMONY_TOOLS/tool/node"
export OHPM_HOME="$HARMONY_TOOLS/ohpm"
ohpm config set registry https://ohpm.openharmony.cn/ohpm/
ohpm install --all
hvigorw --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
# Do not invent a signature or rename an arbitrary ZIP as a HAP.
hap_file="$(find entry/build/default/outputs -type f -name '*unsigned.hap' -print -quit)"
if [[ -z "$hap_file" ]]; then
  echo 'No unsigned HAP was produced by Hvigor' >&2
  exit 1
fi
artifact="/artifacts/ANote-${APP_VERSION}-harmonyos-preview-unsigned.hap"
cp "$hap_file" "$artifact"
unzip -t "$artifact" > /artifacts/harmonyos-hap-integrity.txt
unzip -l "$artifact" > /artifacts/harmonyos-hap-contents.txt
unzip -p "$artifact" module.json > /artifacts/harmonyos-package.json
node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const data=JSON.parse(fs.readFileSync('/artifacts/harmonyos-package.json','utf8'));
assert.equal(data.app.bundleName,'cn.anote.mobile.preview');
assert.equal(data.app.versionName,process.env.APP_VERSION);
assert.equal(data.app.versionCode,Number(process.env.APP_VERSION_CODE));
const archive=fs.readFileSync('/artifacts/harmonyos-hap-contents.txt','utf8');
assert(archive.includes('ets/modules.abc'),'HAP must contain compiled ArkTS bytecode');
assert(archive.includes('resources.index'),'HAP must contain compiled resources');
console.log('Verified native HAP bundle, version, ArkTS bytecode and resources');
JS
cd /artifacts
sha256sum "$(basename "$artifact")" > harmonyos-SHA256SUMS

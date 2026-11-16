import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { validateMobileReleaseManifest } from "../apps/api/dist/mobile-releases.js";

export function mobilePreviewPackagesForVersion(version,legacyAndroidSuffix=false) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Invalid mobile build version");
  return [
    { platform: "android", kind: "apk", version: version+(legacyAndroidSuffix?"-preview":""), channel: "preview", signing: "test", file: `ANote-${version}-android-preview.apk`, checksum: "android-SHA256SUMS" },
    { platform: "harmonyos", kind: "hap", version, channel: "preview", signing: "unsigned", file: `ANote-${version}-harmonyos-preview-unsigned.hap`, checksum: "harmonyos-SHA256SUMS" },
    { platform: "ios", kind: "source", version, channel: "preview", signing: "source", file: `ANote-${version}-ios-source.tar.gz`, checksum: "ios-source-SHA256SUMS" },
  ];
}
// Immutable 0.5.0 artifacts predate the version metadata file.
export const mobilePreviewPackages = mobilePreviewPackagesForVersion("0.5.0",true);
export async function hashMobileFile(file) {
  const value = createHash("sha256");
  for await (const bytes of createReadStream(file)) value.update(bytes);
  return value.digest("hex");
}
export async function createMobileReleaseCatalog(source) {
  const metadataFile=path.join(source,"mobile-version.json"),stat=await fs.lstat(metadataFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  let version="0.5.0";
  if(stat){
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Mobile version metadata must be a regular file");
    const metadata=JSON.parse(await fs.readFile(metadataFile,"utf8"));
    if(metadata.format!=="anote-mobile-build-version"||typeof metadata.version!=="string")throw new Error("Invalid mobile build metadata");
    mobilePreviewPackagesForVersion(metadata.version);
    const [major,minor,patch]=metadata.version.split('.').map(Number);
    if(major>999||minor>99||patch>99||metadata.versionCode!==major*10000+minor*100+patch)throw new Error("Invalid mobile build number");
    version=metadata.version;
  }
  const packages = [];
  for (const { checksum, ...item } of mobilePreviewPackagesForVersion(version,!stat)) {
    const file = path.join(source, item.file), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Mobile release source must be a regular file");
    const records = (await fs.readFile(path.join(source, checksum), "utf8")).trim().split(/\r?\n/).map(line => /^([a-f0-9]{64})  (.+)$/.exec(line));
    const matches = records.filter(record => record?.[2] === item.file);
    const sha256 = await hashMobileFile(file);
    if (matches.length !== 1 || matches[0][1] !== sha256) throw new Error("Mobile release checksum mismatch");
    packages.push({ ...item, bytes: stat.size, sha256 });
  }
  return validateMobileReleaseManifest({ format: "anote-mobile-releases", packages });
}

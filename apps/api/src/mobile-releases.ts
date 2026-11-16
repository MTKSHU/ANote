import fs from "node:fs/promises";
import path from "node:path";
import { fail } from "./errors.js";

export type MobileReleasePackage = {
  platform: "android" | "harmonyos" | "ios";
  kind: "apk" | "hap" | "source";
  version: string;
  channel: "preview" | "stable";
  signing: "test" | "unsigned" | "release" | "source";
  file: string;
  bytes: number;
  sha256: string;
};
export type MobileReleaseManifest = { format: "anote-mobile-releases"; packages: MobileReleasePackage[] };
const targets = { android: { kind: "apk", extension: ".apk" }, harmonyos: { kind: "hap", extension: ".hap" }, ios: { kind: "source", extension: ".tar.gz" } } as const;

/** A separate catalog keeps mobile versions and installers out of desktop updates. */
export function validateMobileReleaseManifest(input: unknown): MobileReleaseManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid mobile release manifest");
  const value = input as MobileReleaseManifest;
  if (value.format !== "anote-mobile-releases" || !Array.isArray(value.packages) || value.packages.length > 12)
    throw new Error("Invalid mobile release packages");
  const filenames = new Set<string>();
  const packages = value.packages.map(item => {
    if (!item || !Object.hasOwn(targets, item.platform)) throw new Error("Invalid mobile release platform");
    const target = targets[item.platform];
    if (item.kind !== target.kind || typeof item.file !== "string" ||
      !/^ANote-[A-Za-z0-9_.-]+$/.test(item.file) || !item.file.endsWith(target.extension) ||
      typeof item.version !== "string" || item.version.length > 64 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(item.version) ||
      !["preview", "stable"].includes(item.channel) || !["test", "unsigned", "release", "source"].includes(item.signing) ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 4 * 1024 ** 3 ||
      typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || filenames.has(item.file))
      throw new Error("Invalid mobile release package");
    if (item.platform === "ios" ? item.signing !== "source" : item.signing === "source")
      throw new Error("Invalid mobile release signing");
    if (item.channel === "stable" && item.signing !== "release") throw new Error("Invalid stable mobile release");
    filenames.add(item.file);
    return { platform: item.platform, kind: item.kind, version: item.version, channel: item.channel, signing: item.signing, file: item.file, bytes: item.bytes, sha256: item.sha256 };
  });
  return { format: "anote-mobile-releases", packages };
}

export function mobileReleaseList(manifest: MobileReleaseManifest) {
  return { packages: manifest.packages.map(item => ({ ...item, url: "/api/client-releases/mobile/" + encodeURIComponent(item.file) })) };
}

export async function readMobileReleaseManifest(directory: string) {
  try {
    const data = await fs.readFile(path.join(directory, "manifest.json"), "utf8");
    if (data.length > 128 * 1024) throw new Error("Mobile release manifest too large");
    return validateMobileReleaseManifest(JSON.parse(data));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: "anote-mobile-releases", packages: [] } as MobileReleaseManifest;
    fail(503, "移动客户端下载资料暂不可用");
  }
}

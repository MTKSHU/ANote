import { releaseEditorSchema } from "./version-info.js";

export type ReleasePackage = {
  platform: string;
  arch: string;
  file: string;
  bytes: number;
  sha256: string;
};
export type ReleaseManifest = {
  version: string | null;
  editorSchema?: unknown;
  electron?: string;
  signed?: boolean;
  nativeAcceptance?: unknown;
  packages: ReleasePackage[];
  legacyPackages?: ReleasePackage[];
};

export function validateReleaseManifest(input: unknown): ReleaseManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid release manifest");
  const value = input as ReleaseManifest;
  if (!Array.isArray(value.packages) || value.legacyPackages !== undefined && !Array.isArray(value.legacyPackages))
    throw new Error("Missing release packages");
  for (const packages of [value.packages, value.legacyPackages || []]) {
    if (packages.length > 20) throw new Error("Too many release packages");
    for (const item of packages) {
      if (!item || typeof item.platform !== "string" || typeof item.arch !== "string" ||
        typeof item.file !== "string" || !/^(?:ANote|ANote|SimpleNote)-[A-Za-z0-9_.-]+$/.test(item.file) ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes <= 0)
        throw new Error("Invalid release package");
    }
  }
  const known = new Map<string, ReleasePackage>();
  for (const item of [...value.packages, ...(value.legacyPackages || [])]) {
    const previous = known.get(item.file);
    if (previous && ["platform", "arch", "bytes", "sha256"].some(key => previous[key as keyof ReleasePackage] !== item[key as keyof ReleasePackage]))
      throw new Error("Ambiguous release package");
    known.set(item.file, item);
  }
  return value;
}

export function releasePackages(manifest: ReleaseManifest, brand?: unknown): ReleasePackage[] {
  // Old clients do not send a brand and validate the historical filename and
  // bundle identity. New download pages and clients explicitly request ANote.
  return brand === "ANote" || !manifest.legacyPackages ? manifest.packages : manifest.legacyPackages;
}

export function releasePackage(manifest: ReleaseManifest, filename: string) {
  return [...manifest.packages, ...(manifest.legacyPackages || [])].find(item => item.file === filename);
}

export function releaseList(manifest: ReleaseManifest, brand?: unknown) {
  return {
    version: manifest.version,
    editor_schema: releaseEditorSchema(manifest.editorSchema),
    electron: manifest.electron,
    signed: manifest.signed,
    nativeAcceptance: manifest.nativeAcceptance,
    packages: releasePackages(manifest, brand).map(({ platform, arch, file, bytes, sha256 }) => ({
      platform, arch, file, bytes, sha256,
      url: "/api/client-releases/" + encodeURIComponent(file),
    })),
  };
}

export class ReleaseCheckError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Public update discovery exposes one target's download metadata, not the manifest. */
export function releaseCheck(manifest: ReleaseManifest, query: { platform?: unknown; arch?: unknown; brand?: unknown }) {
  const supported = new Set(["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"]);
  if (typeof query.platform !== "string" || typeof query.arch !== "string" ||
      !supported.has(query.platform + "-" + query.arch))
    throw new ReleaseCheckError(400, "暂不支持此操作系统和架构的客户端更新");
  if (query.brand !== undefined && query.brand !== "ANote" && query.brand !== "SimpleNote")
    throw new ReleaseCheckError(400, "客户端更新渠道无效");
  const packages = releasePackages(manifest, query.brand);
  const empty = { version: null, editor_schema: releaseEditorSchema(manifest.editorSchema), signed: manifest.signed === true, requires_auth: true, packages: [] };
  if (manifest.version === null && packages.length === 0) return empty;
  if (typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) ||
      manifest.version.split(".").some(part => !Number.isSafeInteger(Number(part))))
    throw new ReleaseCheckError(503, "客户端发布版本资料无效");
  const matches = packages.filter(item => item.platform === query.platform && item.arch === query.arch);
  if (!matches.length) throw new ReleaseCheckError(404, "暂无适用于此操作系统和架构的客户端更新包");
  if (matches.length !== 1) throw new ReleaseCheckError(503, "客户端更新包资料不唯一");
  const item = matches[0], extension = query.platform === "win32" ? ".zip" : ".tar.gz";
  if (!["ANote", "SimpleNote", "ANote"].some(brand => item.file === `${brand}-${manifest.version}-${query.platform}-${query.arch}${extension}`) ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 1024 ** 3 || !/^[a-f0-9]{64}$/.test(item.sha256))
    throw new ReleaseCheckError(503, "客户端更新包资料无效");
  return {
    version: manifest.version,
    editor_schema: releaseEditorSchema(manifest.editorSchema),
    signed: manifest.signed === true,
    requires_auth: true,
    packages: [{ platform: item.platform, arch: item.arch, file: item.file, bytes: item.bytes, sha256: item.sha256, url: "/api/client-releases/" + encodeURIComponent(item.file) }],
  };
}

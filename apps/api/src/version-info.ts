import fs from "node:fs/promises";

export type PlatformVersion = {
  build_id: string | null;
  web_entry: string | null;
  editor_schema: number;
  desktop_version: string | null;
};

export function releaseEditorSchema(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

async function readText(filename: string, maximumBytes: number) {
  try {
    const value = await fs.readFile(filename, "utf8");
    return Buffer.byteLength(value) <= maximumBytes ? value : null;
  } catch {
    // A missing or incomplete deployment should not interrupt an open note.
    return null;
  }
}

export async function readVersionInfo(
  webIndex: string,
  releaseManifest: string,
  editorSchema: number,
): Promise<PlatformVersion> {
  const [html, manifest] = await Promise.all([
    readText(webIndex, 256 * 1024),
    readText(releaseManifest, 1024 * 1024),
  ]);
  const entry = html?.match(
    /<script\b(?=[^>]*\stype\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*(["'])(\/assets\/index-([A-Za-z0-9_-]{6,64})\.js)\1[^>]*>/i,
  );
  let desktopVersion: string | null = null;
  try {
    const value: unknown = manifest && JSON.parse(manifest);
    if (value && typeof value === "object" && "version" in value) {
      const version = value.version;
      if (
        typeof version === "string" &&
        version.length <= 64 &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)
      )
        desktopVersion = version;
    }
  } catch {
    // The authenticated release endpoint reports invalid release manifests.
  }
  return {
    build_id: entry?.[3] || null,
    web_entry: entry?.[2] || null,
    editor_schema: editorSchema,
    desktop_version: desktopVersion,
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createMobileReleaseCatalog, hashMobileFile } from "./mobile-release-catalog.mjs";

// Explicit paths keep test copies and the final NAS publication separate.
// Run only after building apps/api; this never changes the desktop manifest.
const [sourceArgument, targetArgument] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) throw new Error("Usage: node scripts/install-mobile-releases.mjs SOURCE CLIENTS_DIRECTORY/mobile");
const source = await fs.realpath(sourceArgument), target = path.resolve(targetArgument), parent = path.dirname(target);
if (path.basename(target) !== "mobile" || path.basename(parent) !== "clients") throw new Error("Mobile releases require a dedicated clients/mobile directory");
if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) throw new Error("Mobile source and destination must be separate");
if ((await fs.lstat(parent)).isSymbolicLink() || (await fs.lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error("Mobile release destination cannot be a symlink");
const manifest = await createMobileReleaseCatalog(source);
await fs.mkdir(target, { recursive: true, mode: 0o755 });
// Validate existing immutable names before writing any new file. Do not
// replace files referenced by an earlier catalog with different content.
for (const item of manifest.packages) {
  const file = path.join(target, item.file), existing = await fs.lstat(file).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size !== item.bytes || await hashMobileFile(file) !== item.sha256)) throw new Error("Existing mobile release differs from its immutable source");
}
for (const item of manifest.packages) {
  const destination = path.join(target, item.file);
  if (await fs.lstat(destination).catch(() => null)) continue;
  const temporary = path.join(target, randomUUID() + ".partial");
  try {
    await fs.copyFile(path.join(source, item.file), temporary);
    if ((await fs.stat(temporary)).size !== item.bytes || await hashMobileFile(temporary) !== item.sha256) throw new Error("Copied mobile release checksum mismatch");
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}
const temporary = path.join(target, randomUUID() + ".manifest.partial");
try {
  await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  await fs.rename(temporary, path.join(target, "manifest.json"));
} finally { await fs.rm(temporary, { force: true }); }
console.log(JSON.stringify({ installed: manifest.packages.map(item => item.file), desktopManifestChanged: false, directory: target }));

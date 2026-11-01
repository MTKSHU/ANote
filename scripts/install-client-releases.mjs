import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
const source = "/workspace/artifacts/releases",
  root = "/nas-root",
  target = path.join(root, "clients");
const marker = JSON.parse(
  await fs.readFile(path.join(root, ".anote-storage.json"), "utf8"),
);
if (marker.kind !== "anote-nas")
  throw new Error("Unrecognized NAS data root");
const manifest = JSON.parse(
  await fs.readFile(path.join(source, "manifest.json"), "utf8"),
);
if (manifest.packages.length !== 4)
  throw new Error("Expected four platform builds");
for (const item of manifest.packages) {
  if (!/^ANote-[A-Za-z0-9_.-]+$/.test(item.file))
    throw new Error("Invalid filename");
  const file = path.join(source, item.file),
    hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (
    hash.digest("hex") !== item.sha256 ||
    (await fs.stat(file)).size !== item.bytes
  )
    throw new Error("Release checksum mismatch");
}
if ((await fs.lstat(target).catch(() => null))?.isSymbolicLink())
  throw new Error("Release directory cannot be a symlink");
await fs.mkdir(target, { recursive: true, mode: 0o755 });
for (const item of manifest.packages) {
  const temporary = path.join(target, randomUUID() + ".partial");
  try {
    await fs.copyFile(path.join(source, item.file), temporary);
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, path.join(target, item.file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
await fs.writeFile(
  path.join(target, "manifest.json.partial"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o644 },
);
await fs.rename(
  path.join(target, "manifest.json.partial"),
  path.join(target, "manifest.json"),
);
console.log(
  JSON.stringify({
    installed: manifest.packages.map((item) => item.file),
    directory: process.env.ANOTE_DATA_ROOT ? path.join(process.env.ANOTE_DATA_ROOT,"clients") : "configured-data-root/clients",
  }),
);

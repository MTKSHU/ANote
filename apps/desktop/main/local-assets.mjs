import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

export async function localAsset(request, url, session) {
  const match = /^\/api\/assets\/([\w-]{1,80})\/file$/.exec(url.pathname);
  if (
    !match ||
    !["GET", "HEAD"].includes(request.method) ||
    !session.settings.user
  )
    return null;
  for (const doc of session.settings.documents) {
    const root = path.resolve(doc.directory);
    if ((await fs.lstat(root).catch(() => null))?.isSymbolicLink()) continue;
    let current = root,
      safe = true;
    // A local sync directory is selected by the user. Never follow links inserted beneath it.
    for (const part of [".anote", doc.id + ".base.json"]) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(() => null);
      if (!stat || stat.isSymbolicLink()) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    let base;
    try {
      base = JSON.parse(await fs.readFile(current, "utf8"));
    } catch {
      continue;
    }
    const asset = base.assets?.find(
      (item) =>
        item.id === match[1] &&
        new URL(item.url, session.settings.serverURL).pathname === url.pathname,
    );
    if (!asset) continue;
    const file = path.resolve(root, asset.path);
    if (!file.startsWith(root + path.sep)) continue;
    current = root;
    for (const part of path.relative(root, file).split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(() => null);
      if (!stat || stat.isSymbolicLink()) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    const size = (await fs.stat(file)).size;
    if (asset.bytes !== undefined && asset.bytes !== size) continue;
    let start = 0,
      end = size - 1,
      status = 200;
    const headers = new Headers({
      "Content-Type": asset.mime || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-ANote-Cache": "local-sync",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
    if (request.headers.has("range")) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(
        request.headers.get("range") || "",
      );
      if (!range || (!range[1] && !range[2]))
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      if (!range[1]) start = Math.max(0, size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    headers.set("Content-Length", String(end - start + 1));
    return new Response(
      request.method === "HEAD"
        ? null
        : Readable.toWeb(createReadStream(file, { start, end })),
      { status, headers },
    );
  }
  return null;
}

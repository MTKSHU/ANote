import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Request, Response } from "express";
import { fail } from "./errors.js";

export const storageRoot = path.resolve(
  process.env.ASSET_ROOT || "/data/resources",
);
export const CHUNK_BYTES = 16 * 1024 ** 2;
export const MAX_ASSET_BYTES = Number(
  process.env.MAX_ASSET_BYTES || 32 * 1024 ** 3,
);
if (!Number.isSafeInteger(MAX_ASSET_BYTES) || MAX_ASSET_BYTES < CHUNK_BYTES)
  throw new Error("Invalid MAX_ASSET_BYTES");
export const storagePath = (
  area: "originals" | "uploads" | "derived",
  key: string,
) => {
  if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(key) || key.startsWith("."))
    throw new Error("Invalid storage key");
  return path.join(storageRoot, area, key);
};
export async function initializeStorage() {
  for (const area of ["originals", "uploads", "derived"])
    await fs.mkdir(path.join(storageRoot, area), {
      recursive: true,
      mode: 0o750,
    });
}
export async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function receiveChunk(
  req: Request,
  target: string,
  expected: number,
  hash: string,
) {
  let count = 0;
  const digest = createHash("sha256");
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (count > expected) return callback(new Error("Chunk too large"));
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      req,
      meter,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    if (count !== expected || digest.digest("hex") !== hash)
      fail(422, "分块大小或校验值不匹配，请重试");
  } catch (error) {
    await fs.rm(target, { force: true });
    if ((error as any).status) throw error;
    fail(400, "分块传输中断或超出大小，请重试");
  }
}
export async function describeFile(
  file: string,
  filename: string,
  bytes: number,
) {
  const handle = await fs.open(file, "r");
  const header = Buffer.alloc(Math.min(65536, bytes));
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const ext = path.extname(filename).toLowerCase(),
    prefix = header.toString("utf8");
  let kind = "file",
    mime = "application/octet-stream";
  const metadata: Record<string, any> = {};
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    kind = "image";
    mime = "image/png";
  } else if (header[0] === 255 && header[1] === 216 && header[2] === 255) {
    kind = "image";
    mime = "image/jpeg";
  } else if (/^GIF8[79]a/.test(prefix)) {
    kind = "image";
    mime = "image/gif";
  } else if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
    kind = "image";
    mime = "image/webp";
  } else if (prefix.slice(4, 8) === "ftyp") {
    kind = ext === ".m4a" ? "audio" : "video";
    mime = kind === "audio" ? "audio/mp4" : "video/mp4";
  } else if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) {
    kind = "video";
    mime = "video/webm";
  } else if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WAVE") {
    kind = "audio";
    mime = "audio/wav";
  } else if (prefix.startsWith("OggS")) {
    kind = "audio";
    mime = "audio/ogg";
  } else if (prefix.startsWith("fLaC")) {
    kind = "audio";
    mime = "audio/flac";
  } else if (
    prefix.startsWith("ID3") ||
    (header[0] === 255 && (header[1] & 224) === 224)
  ) {
    kind = "audio";
    mime = "audio/mpeg";
  } else if (prefix.startsWith("%PDF-")) {
    mime = "application/pdf";
  } else if (
    [".docx", ".pptx", ".xlsx"].includes(ext) &&
    header[0] === 80 &&
    header[1] === 75
  ) {
    mime = (
      {
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      } as Record<string, string>
    )[ext];
  } else if (
    [".doc", ".ppt", ".xls"].includes(ext) &&
    header.subarray(0, 4).equals(Buffer.from([208, 207, 17, 224]))
  ) {
    mime = (
      {
        ".doc": "application/msword",
        ".ppt": "application/vnd.ms-powerpoint",
        ".xls": "application/vnd.ms-excel",
      } as Record<string, string>
    )[ext];
  } else if (ext === ".glb" && prefix.startsWith("glTF")) {
    kind = "mesh";
    metadata.format = "glb";
  } else if (ext === ".ply" && /^ply\r?\n/.test(prefix)) {
    const plyHeader = prefix.split("end_header")[0];
    kind = ["f_dc_0", "opacity", "scale_0", "rot_0"].every((v) =>
      plyHeader.includes(" " + v),
    )
      ? "gaussian"
      : /element face [1-9]/.test(plyHeader)
        ? "mesh"
        : "pointcloud";
    metadata.format = "ply";
    metadata.elements = Number(
      plyHeader.match(/element vertex (\d+)/)?.[1] || 0,
    );
  } else if (ext === ".splat" && bytes % 32 === 0) {
    kind = "gaussian";
    metadata.format = "splat";
    metadata.elements = bytes / 32;
  } else if (ext === ".obj" && /(^|\n)v\s+[-\d.]/.test(prefix)) {
    kind = "mesh";
    metadata.format = "obj";
  } else if (
    [
      ".blend",
      ".gltf",
      ".unity",
      ".unitypackage",
      ".uasset",
      ".umap",
      ".uproject",
      ".zip",
      ".7z",
      ".tar",
      ".gz",
    ].includes(ext)
  ) {
    kind = "project";
  } else if (
    [".md", ".txt", ".csv", ".json", ".py", ".yaml", ".yml", ".log"].includes(
      ext,
    ) &&
    !header.includes(0)
  ) {
    kind = "text";
    mime = "text/plain; charset=utf-8";
  }
  return { kind, mime, metadata };
}
export async function sendFile(
  req: Request,
  res: Response,
  file: string,
  options: { mime: string; filename: string; hash: string; inline?: boolean },
) {
  const size = (await fs.stat(file)).size;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", options.mime);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", '"' + options.hash + '"');
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader(
    "Content-Disposition",
    (options.inline ? "inline" : "attachment") +
      '; filename="' +
      options.filename.replace(/[^\x20-\x7e]|["\\]/g, "_") +
      '"' +
      "; filename*=UTF-8''" +
      encodeURIComponent(options.filename).replace(
        /['()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16),
      ),
  );
  let start = 0,
    end = size - 1;
  if (
    req.headers.range &&
    (!req.headers["if-range"] ||
      req.headers["if-range"] === '"' + options.hash + '"')
  ) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    ) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(file, { start, end }), res);
  } catch (error) {
    if (!res.destroyed) res.destroy(error as Error);
  }
}

import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NestFactory } from "@nestjs/core";

test("移动列表与实际APK下载要求有效账号、支持Range，并与桌面更新保持隔离", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anote-mobile-http-")), previous = process.env.DESKTOP_RELEASE_DIR;
  process.env.DESKTOP_RELEASE_DIR = directory;
  const binary = Buffer.from("PK\u0003\u0004mobile-preview-bytes"), sha256 = createHash("sha256").update(binary).digest("hex"), mobileRoot = path.join(directory, "mobile");
  const item = { platform: "android", kind: "apk", version: "0.5.0-preview", channel: "preview", signing: "test", file: "ANote-0.5.0-android-preview.apk", bytes: binary.length, sha256 };
  await fs.mkdir(mobileRoot); await fs.writeFile(path.join(mobileRoot, item.file), binary);
  await fs.writeFile(path.join(mobileRoot, "manifest.json"), JSON.stringify({ format: "anote-mobile-releases", packages: [item] }));
  const desktop = { version: "0.5.1", editorSchema: 8, packages: [{ platform: "linux", arch: "x64", file: "ANote-0.5.1-linux-x64.tar.gz", bytes: 123, sha256 }] };
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(desktop));
  const { ReleasesModule } = await import("../dist/releases.js"), { db, digest } = await import("../dist/database.js");
  const query = db.query, token = "a".repeat(43);
  // Isolated controller integration: exercise the real auth parser/hash/query,
  // without starting application bootstrap or accessing any real database.
  db.query = async (sql, values) => { assert.match(sql, /FROM sessions s JOIN users u/); return { rows: values[0] === digest(token) ? [{ id: "synthetic-user", name: "Reader", username: "reader", is_admin: false }] : [] }; };
  const app = await NestFactory.create(ReleasesModule, { logger: false }); await app.listen(0, "127.0.0.1"); const origin = await app.getUrl();
  t.after(async () => { await app.close(); db.query = query; await db.end(); await fs.rm(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.DESKTOP_RELEASE_DIR; else process.env.DESKTOP_RELEASE_DIR = previous; });
  const get = (url, headers = {}) => fetch(origin + url, { headers, redirect: "error" }), auth = { Authorization: "Bearer " + token };
  for (const endpoint of ["/api/client-releases/mobile", "/api/client-releases/mobile/" + item.file]) {
    for (const headers of [{}, { Authorization: "Bearer " + "b".repeat(43) }]) assert.equal((await get(endpoint, headers)).status, 401);
  }
  const catalog = await get("/api/client-releases/mobile", auth); assert.equal(catalog.status, 200); assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.deepEqual(await catalog.json(), { packages: [{ ...item, url: "/api/client-releases/mobile/" + item.file }] });
  const response = await get("/api/client-releases/mobile/" + item.file, auth); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), binary);
  const partial = await get("/api/client-releases/mobile/" + item.file, { ...auth, Range: "bytes=0-3" }); assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 0-3/" + binary.length); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), binary.subarray(0, 4));
  assert.equal((await get("/api/client-releases/mobile/ANote-unknown.apk", auth)).status, 404);
  assert.equal((await get("/api/client-releases/mobile/..%2Fmanifest.json", auth)).status, 404);
  assert.equal((await get("/api/client-releases/" + item.file, auth)).status, 404);
  const list = await get("/api/client-releases?brand=ANote", auth); assert.deepEqual((await list.json()).packages.map(value => value.file), [desktop.packages[0].file]);
  const update = await get("/api/client-releases/check?brand=ANote&platform=linux&arch=x64"); assert.equal(update.status, 200); assert.equal((await update.json()).version, "0.5.1");
  assert.equal((await get("/api/client-releases/check?brand=ANote&platform=android&arch=arm64")).status, 400);
  await fs.rename(path.join(mobileRoot, item.file), path.join(directory, "outside.apk")); await fs.symlink(path.join(directory, "outside.apk"), path.join(mobileRoot, item.file));
  assert.equal((await get("/api/client-releases/mobile/" + item.file, auth)).status, 503);
});

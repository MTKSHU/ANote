import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { gzipSync, deflateRawSync } from "node:zlib";
import { DesktopUpdater, newerVersion, parseReleaseVersion } from "../../apps/desktop/main/updater.mjs";
import { extractUpdate } from "../../apps/desktop/main/update-archive.mjs";
import { launchPreparedInstall, WINDOWS_INSTALLER } from "../../apps/desktop/main/updater-install.mjs";

const version = "0.4.13", rootName = "SimpleNote-linux-x64";
const sha = (data) => createHash("sha256").update(data).digest("hex");
function asar(ver = version, productName = "SimpleNote") {
  const pkg = Buffer.from(JSON.stringify({ name: "anote-desktop", productName, version: ver, main: "dist/main.cjs" }));
  const json = Buffer.from(JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "0" }, dist: { files: { "main.cjs": { size: 0, offset: String(pkg.length) } } } } }));
  const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4); header.writeUInt32LE(header.length - 4, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8);
  const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4); prefix.writeUInt32LE(header.length, 4); return Buffer.concat([prefix, header, pkg]);
}
function executable(platform = "linux") {
  const result = Buffer.alloc(128);
  if (platform === "linux") { result.set([127, 69, 76, 70, 2, 1]); result.writeUInt16LE(62, 18); }
  else if (platform === "win32") { result.write("MZ"); result.writeUInt32LE(64, 60); result.writeUInt32LE(0x4550, 64); result.writeUInt16LE(0x8664, 68); }
  else { result.writeUInt32LE(0xfeedfacf); result.writeUInt32LE(0x01000007, 4); }
  return result;
}
function tar(entries) {
  const output = [];
  for (const { name, data = Buffer.alloc(0), mode = 0o644, type = "0", link = "" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write(mode.toString(8).padStart(7, "0") + "\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100); header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    output.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  output.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(output));
}
function bundleEntries(ver = version, root = rootName, brand = "SimpleNote") {
  return [{ name: root + "/" + brand, data: executable(), mode: 0o755 }, { name: root + "/resources/app.asar", data: asar(ver, brand) }];
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name), compressed = deflateRawSync(data), crc = crc32(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8); head.writeUInt32LE(crc, 14); head.writeUInt32LE(compressed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(filename.length, 26);
    local.push(head, filename, compressed);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(filename.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, filename); offset += head.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function temporary(work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anote-updater-"));
  try { return await work(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function service(work, options = {}) {
  const releaseVersion = options.version || version, brand = options.brand || "SimpleNote";
  const archive = options.archive || tar(bundleEntries(releaseVersion, `${brand}-linux-x64`, brand)), file = `${brand}-${releaseVersion}-linux-x64.tar.gz`, requests = [];
  const manifest = { version: releaseVersion, packages: [{ platform: "linux", arch: "x64", file, bytes: archive.length, sha256: sha(archive), url: "/api/client-releases/" + file }] };
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization, range: request.headers.range });
    const url = new URL(request.url, "http://test");
    if (url.pathname === "/api/client-releases/check") {
      if (options.checkStatus) { response.writeHead(options.checkStatus).end(); return; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ...manifest, requires_auth: true })); return;
    }
    if (url.pathname === "/api/version") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ desktop_version: manifest.version })); return; }
    if (request.headers.authorization !== "Bearer " + (options.token || "private-test-token")) { response.writeHead(401).end(); return; }
    if (url.pathname === "/api/client-releases") {
      if (options.legacyStatus) { response.writeHead(options.legacyStatus).end(); return; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(manifest)); return;
    }
    if (options.downloadStatus) { response.writeHead(options.downloadStatus).end(); return; }
    if (options.redirect) { response.writeHead(302, { Location: options.redirect }).end(); return; }
    const start = request.headers.range ? Number(request.headers.range.match(/^bytes=(\d+)-$/)?.[1]) : 0;
    response.writeHead(start ? 206 : 200, { "Content-Length": archive.length - start, ...(start ? { "Content-Range": `bytes ${start}-${archive.length - 1}/${archive.length}` } : {}) });
    if (options.holdDownload) { response.write(archive.subarray(start, Math.floor(archive.length / 2))); options.holdDownload.release = () => response.end(archive.subarray(Math.floor(archive.length / 2))); options.holdDownload.started(); }
    else if (options.interrupt && !start) { response.write(archive.subarray(0, Math.floor(archive.length / 2))); setTimeout(() => response.destroy(), 30); }
    else response.end(archive.subarray(start));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await temporary((directory) => work({ archive, manifest, requests, directory, controls: options, serverURL: `http://127.0.0.1:${server.address().port}` })); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
function updater(directory, extra = {}) { return new DesktopUpdater({ directory: path.join(directory, "updates"), currentVersion: "0.4.12", platform: "linux", arch: "x64", allowHTTP: true, ...extra }); }

test("strict stable version comparisons reject downgrade, coercion and ambiguous versions", () => {
  assert.equal(newerVersion("0.4.13", "0.4.12"), true); assert.equal(newerVersion("0.4.12", "0.4.13"), false); assert.equal(newerVersion("0.4.13", "0.4.13"), false); assert.equal(newerVersion("1.0.0", "0.99.99"), true);
  for (const value of ["v0.4.13", "0.04.13", "0.4.13-beta", "0.4.13+build", "0.4", "0.4.9007199254740993", null]) assert.throws(() => parseReleaseVersion(value));
});

test("manifest uses exact OS/architecture and refuses external URLs before any authenticated download", async () => service(async ({ directory, manifest, requests, serverURL }) => {
  const client = updater(directory), credentials = { serverURL, token: "private-test-token" };
  manifest.packages[0].url = "https://attacker.invalid/archive";
  await assert.rejects(client.check(credentials), /当前服务器/); assert.equal(requests.length, 1);
  manifest.packages[0].url = "/api/client-releases/" + manifest.packages[0].file; manifest.packages[0].arch = "arm64";
  await assert.rejects(client.check(credentials), /架构/);
  manifest.packages[0].arch = "x64"; manifest.packages[0].file = null; manifest.packages[0].url = "/api/client-releases/null";
  await assert.rejects(client.check(credentials), /清单无效/);
  assert.equal(JSON.stringify(client.snapshot()).includes("private-test-token"), false);
}));

test("production HTTP and manifest downgrade stay rejected while anonymous checks only advertise protected downloads", async () => service(async ({ directory, manifest, serverURL }) => {
  const secure = updater(directory, { allowHTTP: false }); await assert.rejects(secure.check({ serverURL, token: "private-test-token" }), /HTTPS/);
  const client = updater(directory); await client.check({ serverURL }); assert.equal(client.snapshot().status, "available"); assert.equal(client.snapshot().needsAuth, true);
  await assert.rejects(client.download({ serverURL }), /登录/);
  manifest.version = "0.4.11"; await client.check({ serverURL, token: "private-test-token" }); assert.equal(client.snapshot().status, "up-to-date"); assert.equal(client.snapshot().canInstall, false);
}));

test("authenticated streaming download verifies SHA, ASAR version and executable without running package code", async () => service(async ({ directory, serverURL, requests }) => {
  const client = updater(directory), credentials = { serverURL, token: "private-test-token" };
  await client.check(credentials); await client.download(credentials);
  const result = client.snapshot(); assert.equal(result.status, "ready"); assert.equal(result.progress, 1); assert.equal(result.downloadedBytes, result.totalBytes); assert.equal(result.canInstall, false);
  assert.equal(requests[0].auth, undefined); assert.equal(requests.slice(1).every((request) => request.auth === "Bearer private-test-token"), true);
  await assert.rejects(client.prepareInstall(), /开发模式/);
  const files = await fs.readdir(path.dirname(result.downloadPath));
  for (const file of files.filter((file) => !file.startsWith("extracted"))) assert.equal((await fs.readFile(path.join(path.dirname(result.downloadPath), file))).includes("private-test-token"), false);
}));

test("download resumes a partial transfer using a validated byte range", async () => service(async ({ directory, serverURL, requests }) => {
  const client = updater(directory), credentials = { serverURL, token: "private-test-token" };
  await client.check(credentials); await assert.rejects(client.download(credentials)); await client.download(credentials);
  assert.equal(client.snapshot().status, "ready"); assert.ok(requests.some((request) => /^bytes=\d+-$/.test(request.range || "")));
}, { interrupt: true }));

test("hash mismatch rejects and deletes corrupt partial; redirect is never followed", async () => {
  await service(async ({ directory, manifest, serverURL }) => {
    manifest.packages[0].sha256 = "f".repeat(64); const client = updater(directory), credentials = { serverURL, token: "private-test-token" };
    await client.check(credentials); await assert.rejects(client.download(credentials), /SHA-256/); assert.equal(client.snapshot().canInstall, false);
    assert.deepEqual(await fs.readdir(path.join(directory, "updates", "f".repeat(64))), []);
  });
  await service(async ({ directory, serverURL, requests }) => { const client = updater(directory), credentials = { serverURL, token: "private-test-token" }; await client.check(credentials); await assert.rejects(client.download(credentials)); assert.equal(requests.length, 2); }, { redirect: "http://127.0.0.1:1/secret" });
});

test("safe tar permits internal links and rejects traversal, hard links, escaping links, bad ASAR version and wrong executable", async () => temporary(async (directory) => {
  const archive = path.join(directory, "archive.tar.gz");
  await fs.writeFile(archive, tar([...bundleEntries(), { name: rootName + "/internal", type: "2", link: "resources" }]));
  const release = { platform: "linux", arch: "x64", version };
  const result = await extractUpdate(archive, path.join(directory, "safe"), release); assert.equal(await fs.readlink(path.join(result.bundle, "internal")), "resources");
  const invalid = [
    [...bundleEntries(), { name: rootName + "/../outside", data: Buffer.from("bad") }],
    [...bundleEntries(), { name: rootName + "/link", type: "2", link: "../../outside" }],
    [...bundleEntries(), { name: rootName + "/link", type: "1", link: rootName + "/SimpleNote" }],
    bundleEntries("0.4.12"),
    [{ name: rootName + "/SimpleNote", data: Buffer.alloc(128), mode: 0o755 }, bundleEntries()[1]],
  ];
  for (let i = 0; i < invalid.length; i++) { await fs.writeFile(archive, tar(invalid[i])); const output = path.join(directory, "bad-" + i); await assert.rejects(extractUpdate(archive, output, release)); await assert.rejects(fs.stat(output), { code: "ENOENT" }); }
}));

test("bounded ZIP extraction validates CRC, Windows paths and PE architecture", async () => temporary(async (directory) => {
  const archive = path.join(directory, "update.zip"), root = "SimpleNote-win32-x64", release = { platform: "win32", arch: "x64", version };
  const entries = [{ name: root + "/SimpleNote.exe", data: executable("win32") }, { name: root + "/resources/app.asar", data: asar() }];
  await fs.writeFile(archive, zip(entries)); assert.equal((await extractUpdate(archive, path.join(directory, "good"), release)).version, version);
  await fs.writeFile(archive, zip([...entries, { name: root + "/../outside", data: Buffer.from("bad") }])); await assert.rejects(extractUpdate(archive, path.join(directory, "bad-path"), release));
  const corrupt = zip(entries); const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); corrupt.writeUInt32LE(123, central + 16);
  await fs.writeFile(archive, corrupt); await assert.rejects(extractUpdate(archive, path.join(directory, "bad-crc"), release), /完整性/);
}));

test("macOS framework links must remain inside the app bundle, including after staging", async () => temporary(async (directory) => {
  const root = "SimpleNote-darwin-x64", app = root + "/SimpleNote.app", archive = path.join(directory, "mac.tar.gz"), release = { platform: "darwin", arch: "x64", version };
  const entries = [{ name: app + "/Contents/MacOS/SimpleNote", data: executable("darwin"), mode: 0o755 }, { name: app + "/Contents/Resources/app.asar", data: asar() }, { name: app + "/Contents/Frameworks/Test.framework/Versions/A/content", data: Buffer.from("framework") }, { name: app + "/Contents/Frameworks/Test.framework/Versions/Current", type: "2", link: "A" }];
  await fs.writeFile(archive, tar(entries)); await extractUpdate(archive, path.join(directory, "good-mac"), release);
  await fs.writeFile(archive, tar([...entries, { name: root + "/payload", data: Buffer.from("outside-app") }, { name: app + "/escape", type: "2", link: "../payload" }]));
  await assert.rejects(extractUpdate(archive, path.join(directory, "bad-mac"), release), /应用本体/);
}));

test("prepareInstall copies a validated bundle beside the app and keeps userdata separate", async () => service(async ({ directory, serverURL }) => {
  const installation = path.join(directory, "applications", "SimpleNote-linux-x64"); await fs.mkdir(path.join(installation, "resources"), { recursive: true });
  await fs.writeFile(path.join(installation, "SimpleNote"), executable(), { mode: 0o755 }); await fs.writeFile(path.join(installation, "resources", "app.asar"), asar("0.4.12"));
  const client = updater(directory, { isPackaged: true, execPath: path.join(installation, "SimpleNote") }), credentials = { serverURL, token: "private-test-token" };
  await client.check(credentials); await client.download(credentials); const plan = await client.prepareInstall();
  assert.equal(plan.target, installation); assert.equal(path.dirname(plan.replacement), path.dirname(installation)); assert.equal(await fs.readFile(path.join(plan.target, "resources", "app.asar"), "hex"), asar("0.4.12").toString("hex"));
  assert.equal(client.snapshot().status, "preparing"); await assert.rejects(client.prepareInstall(), /任务正在进行/); assert.equal((await client.check(credentials)).status, "preparing");
  await assert.rejects(client.launchInstall({ ...plan }), /计划无效/);
  await client.discardInstall(plan, new Error("local save failed")); assert.equal(client.snapshot().status, "ready"); await assert.rejects(fs.stat(plan.replacement), { code: "ENOENT" });
}));

async function waitResult(file, expected) {
  for (let count = 0; count < 80; count++) {
    let result; try { result = await fs.readFile(file, "utf8"); } catch {}
    if (result === expected) return;
    if (["rollback-failed", "invalid-path", "rename-failed", "exit-timeout"].includes(result)) assert.fail("Installer: " + result);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Installer did not produce " + expected);
}
test("POSIX installer swaps entire directories after exit and rolls back a failed start", { skip: process.platform === "win32" }, async () => temporary(async (directory) => {
  for (const success of [true, false]) {
    const jobDirectory = path.join(directory, String(success)); await fs.mkdir(jobDirectory);
    const plan = { jobDirectory, parentPID: 2147483647, target: path.join(jobDirectory, "app with spaces"), replacement: path.join(jobDirectory, "new app"), backup: path.join(jobDirectory, "previous app"), health: path.join(jobDirectory, "healthy"), result: path.join(jobDirectory, "result"), executable: "SimpleNote" };
    await fs.mkdir(plan.target); await fs.mkdir(plan.replacement);
    await fs.writeFile(path.join(plan.target, "version"), "old"); await fs.writeFile(path.join(plan.replacement, "version"), "new");
    await fs.writeFile(path.join(plan.target, "SimpleNote"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const script = success ? "#!/bin/sh\ntouch \"$(dirname \"$0\")/../healthy\"\nsleep 1\n" : "#!/bin/sh\nexit 1\n";
    await fs.writeFile(path.join(plan.replacement, "SimpleNote"), script, { mode: 0o755 });
    await launchPreparedInstall(plan); await waitResult(plan.result, success ? "installed" : "rolled-back");
    assert.equal(await fs.readFile(path.join(plan.target, "version"), "utf8"), success ? "new" : "old");
    if (success) assert.equal(await fs.readFile(path.join(plan.backup, "version"), "utf8"), "old");
  }
  assert.match(WINDOWS_INSTALLER, /RenameWithRetry/); // Native Windows acceptance remains separate.
}));

test("startup acknowledgement is limited to the installed version and exact private job paths", async () => temporary(async (directory) => {
  const client = updater(directory, { currentVersion: version, execPath: path.join(directory, "app", "SimpleNote") });
  const id = "12345678-1234-1234-1234-123456789abc", jobDirectory = path.join(client.directory, "install-" + id); await fs.mkdir(jobDirectory, { recursive: true });
  const plan = { id, jobDirectory, health: path.join(jobDirectory, "healthy"), result: path.join(jobDirectory, "result.txt"), version, target: path.join(directory, "app"), executable: "SimpleNote" };
  await fs.writeFile(plan.result, "waiting"); await fs.writeFile(path.join(client.directory, "pending-install.json"), JSON.stringify({ ...plan, health: path.join(directory, "outside") })); assert.equal(await client.acknowledgeInstall(), false);
  await fs.writeFile(path.join(client.directory, "pending-install.json"), JSON.stringify(plan)); assert.equal(await client.acknowledgeInstall(), true); assert.equal(await fs.readFile(plan.health, "utf8"), version);
}));

test("ANote release migrates a legacy executable while preserving its launcher path and user data", async () => service(async ({ directory, serverURL, requests }) => {
  const installation = path.join(directory, "applications", "SimpleNote-linux-x64"); await fs.mkdir(path.join(installation, "resources"), { recursive: true });
  await fs.writeFile(path.join(installation, "SimpleNote"), executable(), { mode: 0o755 }); await fs.writeFile(path.join(installation, "resources", "app.asar"), asar("0.4.13"));
  const client = updater(directory, { currentVersion: "0.4.13", isPackaged: true, execPath: path.join(installation, "SimpleNote") }), credentials = { serverURL, token: "private-test-token" };
  await fs.mkdir(client.directory, { recursive: true }); const marker = path.join(client.directory, "user-data-marker"); await fs.writeFile(marker, "must remain");
  await client.check(credentials); assert.equal(requests[0].url, "/api/client-releases/check?brand=ANote&platform=linux&arch=x64"); await client.download(credentials);
  const plan = await client.prepareInstall(); assert.equal(plan.executable, "ANote"); assert.equal(plan.previousExecutable, "SimpleNote"); assert.equal(plan.target, installation);
  assert.equal((await fs.lstat(path.join(plan.replacement, "SimpleNote"))).isFile(), true);
  assert.deepEqual(await fs.readFile(path.join(plan.replacement, "ANote")), await fs.readFile(path.join(plan.replacement, "SimpleNote")));
  assert.equal(await fs.readFile(marker, "utf8"), "must remain"); await client.discardInstall(plan); assert.equal(await fs.readFile(marker, "utf8"), "must remain");
}, { brand: "ANote", version: "0.4.14" }));

test("ANote macOS and Windows archives enforce matching product metadata and canonical program paths", async () => temporary(async (directory) => {
  for (const platform of ["darwin", "win32"]) {
    const root = `ANote-${platform}-x64`, bundle = root + (platform === "darwin" ? "/ANote.app" : ""), resources = platform === "darwin" ? "/Contents/Resources" : "/resources", exe = platform === "darwin" ? "/Contents/MacOS/ANote" : "/ANote.exe";
    const entries = [{ name: bundle + exe, data: executable(platform), mode: 0o755 }, { name: bundle + resources + "/app.asar", data: asar("0.4.14", "ANote") }];
    const filename = path.join(directory, platform + (platform === "win32" ? ".zip" : ".tar.gz"));
    await fs.writeFile(filename, platform === "win32" ? zip(entries) : tar(entries));
    const result = await extractUpdate(filename, path.join(directory, platform), { platform, arch: "x64", version: "0.4.14", brand: "ANote" });
    assert.equal(result.brand, "ANote"); assert.equal(result.executable, exe.slice(1));
    entries[1].data = asar("0.4.14", "SimpleNote"); await fs.writeFile(filename, platform === "win32" ? zip(entries) : tar(entries));
    await assert.rejects(extractUpdate(filename, path.join(directory, platform + "-mismatch"), { platform, arch: "x64", version: "0.4.14", brand: "ANote" }), /产品标识/);
  }
}));

test("POSIX rename migration launches ANote and rolls back using the previous SimpleNote executable", { skip: process.platform === "win32" }, async () => temporary(async (directory) => {
  for (const success of [true, false]) {
    const jobDirectory = path.join(directory, String(success)); await fs.mkdir(jobDirectory);
    const plan = { jobDirectory, parentPID: 2147483647, target: path.join(jobDirectory, "legacy install"), replacement: path.join(jobDirectory, "ANote update"), backup: path.join(jobDirectory, "previous"), health: path.join(jobDirectory, "healthy"), result: path.join(jobDirectory, "result"), executable: "ANote", previousExecutable: "SimpleNote" };
    await fs.mkdir(plan.target); await fs.mkdir(plan.replacement);
    await fs.writeFile(path.join(plan.target, "SimpleNote"), '#!/bin/sh\ntouch "$(dirname "$0")/../rollback-started"\n', { mode: 0o755 });
    const script = success ? '#!/bin/sh\ntouch "$(dirname "$0")/../healthy"\nsleep 1\n' : '#!/bin/sh\nexit 1\n';
    await fs.writeFile(path.join(plan.replacement, "ANote"), script, { mode: 0o755 });
    await launchPreparedInstall(plan); await waitResult(plan.result, success ? "installed" : "rolled-back");
    if (success) { assert.equal((await fs.stat(path.join(plan.target, "ANote"))).isFile(), true); assert.equal((await fs.stat(path.join(plan.backup, "SimpleNote"))).isFile(), true); }
    else { await waitResult(path.join(jobDirectory, "result"), "rolled-back"); await assert.doesNotReject(fs.stat(path.join(plan.target, "SimpleNote"))); await expectFile(path.join(jobDirectory, "rollback-started")); }
  }
}));
async function expectFile(filename) { for (let i = 0; i < 40; i++) { if (await fs.stat(filename).catch(() => null)) return; await new Promise((resolve) => setTimeout(resolve, 25)); } assert.fail("Expected file: " + filename); }

test("anonymous public check exposes a newer matching release without sending a token or downloading binaries", async () => service(async ({ directory, serverURL, requests }) => {
  const client = updater(directory); const result = await client.check({ serverURL });
  assert.equal(result.status, "available"); assert.equal(result.needsAuth, true); assert.equal(result.latestVersion, version); assert.ok(result.release?.sha256);
  assert.equal(requests.length, 1); assert.equal(requests[0].auth, undefined); assert.match(requests[0].url, /platform=linux&arch=x64/);
  await assert.rejects(client.download({ serverURL }), /连接并登录/); assert.equal(requests.length, 1); assert.equal(client.snapshot().release.version, version);
}));

test("older servers' authenticated filename route falls back safely to their protected release manifest", async () => service(async ({ directory, serverURL, requests }) => {
  const client = updater(directory), result = await client.check({ serverURL, token: "private-test-token" });
  assert.equal(result.status, "available"); assert.equal(result.needsAuth, false); assert.equal(result.release.version, version);
  assert.equal(requests.length, 2); assert.equal(requests[0].auth, undefined); assert.equal(requests[1].url, "/api/client-releases?brand=ANote"); assert.equal(requests[1].auth, "Bearer private-test-token");
}, { checkStatus: 401 }));

test("version-only older servers still advertise updates to signed-out users and expired sessions", async () => {
  await service(async ({ directory, serverURL, requests }) => {
    const result = await updater(directory).check({ serverURL }); assert.equal(result.status, "available"); assert.equal(result.latestVersion, version); assert.equal(result.release, null); assert.equal(result.needsAuth, true);
    assert.equal(requests.length, 2); assert.equal(requests[1].url, "/api/version"); assert.equal(requests.every((request) => request.auth === undefined), true);
  }, { checkStatus: 404 });
  await service(async ({ directory, serverURL, requests }) => {
    const result = await updater(directory).check({ serverURL, token: "expired-test-token" }); assert.equal(result.status, "available"); assert.equal(result.release, null); assert.equal(result.needsAuth, true);
    assert.deepEqual(requests.map((request) => request.auth), [undefined, "Bearer expired-test-token", undefined]);
  }, { checkStatus: 401 });
});

test("download 401 retains the notification and requires a new login rather than repeatedly trusting the rejected token", async () => service(async ({ directory, serverURL, controls, requests }) => {
  const client = updater(directory), credentials = { serverURL, token: "private-test-token" };
  await client.check(credentials); controls.downloadStatus = 401; await assert.rejects(client.download(credentials), /登录已失效/);
  assert.equal(client.snapshot().needsAuth, true); assert.equal(client.snapshot().release.version, version); assert.equal(client.snapshot().status, "error");
  controls.downloadStatus = 0; await client.check(credentials); assert.equal(client.snapshot().status, "available"); assert.equal(client.snapshot().needsAuth, true);
  const count = requests.length; await assert.rejects(client.download(credentials), /连接并登录/); assert.equal(requests.length, count);
  controls.token = "new-authenticated-token"; await client.check({ serverURL, token: controls.token }); assert.equal(client.snapshot().needsAuth, false);
  await client.download({ serverURL, token: controls.token }); assert.equal(client.snapshot().status, "ready");
  assert.equal(JSON.stringify(client.snapshot()).includes("new-authenticated-token"), false);
}));

test("a verified ready bundle survives scheduled checks without network requests or loss of install state", async () => service(async ({ directory, serverURL, controls, requests }) => {
  const client = updater(directory), credentials = { serverURL, token: "private-test-token" }; await client.check(credentials); await client.download(credentials);
  const ready = client.snapshot(), count = requests.length; controls.checkStatus = 503;
  const result = await client.check({ serverURL, token: null }); assert.deepEqual(result, ready); assert.equal(requests.length, count); assert.equal(result.needsAuth, false);
  await service(async ({ serverURL: otherServerURL, requests: otherRequests }) => {
    assert.deepEqual(await client.check({ serverURL: otherServerURL, token: "other-server-token" }), ready); assert.equal(otherRequests.length, 0);
  });
}));

test("a check during streaming download is harmless and cannot overwrite progress or the selected package", async () => {
  let started; const waiting = new Promise((resolve) => { started = resolve; }); const gate = { started };
  await service(async ({ directory, serverURL, requests }) => {
    const client = updater(directory), credentials = { serverURL, token: "private-test-token" }; await client.check(credentials);
    const downloading = client.download(credentials); await waiting;
    const count = requests.length, current = client.snapshot(); assert.equal(current.status, "downloading");
    assert.deepEqual(await client.check(credentials), current); assert.equal(requests.length, count);
    gate.release(); await downloading; assert.equal(client.snapshot().status, "ready");
  }, { holdDownload: gate });
});

test("concurrent check triggers share one request and failures keep the already advertised version visible", async () => service(async ({ directory, serverURL, controls, requests }) => {
  const client = updater(directory), credentials = { serverURL };
  const [first, second] = await Promise.all([client.check(credentials), client.check(credentials)]); assert.deepEqual(first, second); assert.equal(requests.length, 1);
  const advertised = client.snapshot().release; controls.checkStatus = 503; await assert.rejects(client.check(credentials), /HTTP 503/);
  assert.equal(client.snapshot().status, "error"); assert.equal(client.snapshot().latestVersion, version); assert.deepEqual(client.snapshot().release, advertised); assert.equal(client.snapshot().needsAuth, true);
  controls.checkStatus = 0; await client.check(credentials); assert.equal(client.snapshot().status, "available"); assert.equal(client.snapshot().error, null);
}));

test("changing server clears unverified package and version-only metadata before a failed check without sending either server's credentials elsewhere", async () => {
  for (const checkStatus of [0, 401]) await service(async ({ directory, serverURL, requests }) => {
    const states = [], client = updater(directory, { onChange: (state) => states.push(state) });
    const original = await client.check({ serverURL }); assert.equal(original.latestVersion, version); assert.ok(original.checkedAt);
    assert.equal(Boolean(original.release), checkStatus === 0);
    const originalRequests = requests.length;
    await service(async ({ serverURL: otherServerURL, requests: otherRequests, controls }) => {
      const credentials = { serverURL: otherServerURL, token: "other-server-token" }, changeIndex = states.length;
      await assert.rejects(client.check(credentials), /HTTP 503/);
      for (const state of states.slice(changeIndex)) { assert.equal(state.latestVersion, null); assert.equal(state.release, null); assert.equal(state.checkedAt, null); }
      assert.equal(client.snapshot().totalBytes, 0); assert.equal(client.snapshot().needsAuth, false);
      await assert.rejects(client.download(credentials), /当前服务器检查/);
      assert.equal(otherRequests.length, 1); assert.equal(otherRequests[0].auth, undefined); assert.equal(requests.length, originalRequests);
      controls.checkStatus = 0; await client.check(credentials); assert.equal(client.snapshot().status, "available");
      await client.check({ serverURL }); assert.equal(client.snapshot().needsAuth, true);
      assert.equal(requests.every((request) => request.auth === undefined), true);
    }, { checkStatus: 503 });
  }, { checkStatus });
});

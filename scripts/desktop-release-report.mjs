import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
const directory = "artifacts/releases",
  manifest = JSON.parse(
    await fs.readFile(directory + "/manifest.json", "utf8"),
  ),
  runtime = JSON.parse(
    await fs.readFile(directory + "/linux-runtime-evidence.json", "utf8"),
  ),
  downloads = JSON.parse(
    await fs.readFile(
      "artifacts/deployment/client-download-evidence.json",
      "utf8",
    ),
  );
assert.equal(manifest.packages.length, 4);
assert.equal(runtime.packaged, true);
assert.equal(runtime.apiLogin, true);
assert.equal(runtime.serverOrigin, downloads.serverOrigin);
assert.equal(runtime.sessionRevoked, true);
assert.ok(Date.parse(runtime.verifiedAt) >= Date.parse(manifest.createdAt), "Runtime verification must use the current packages");
assert.equal(downloads.linuxFullDownloadHashMatched, true);
assert.equal(downloads.rangeAllFour, true);
for (const item of manifest.packages) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(directory + "/" + item.file))
    hash.update(chunk);
  assert.equal(hash.digest("hex"), item.sha256);
  assert.equal(
    downloads.manifest.packages.find((row) => row.file === item.file).sha256,
    item.sha256,
  );
}
const proof = {
  ...manifest,
  linuxRuntime: runtime,
  downloads: {
    authenticated: true,
    serverOrigin: downloads.serverOrigin,
    scope: "Isolated formal API; production OIDC configuration preserved",
    rangeAllFour: true,
    linuxFullChecksum: true,
  },
  nativeAcceptance: {
    linux:
      "Packaged Linux executable in Docker/Xvfb; OS sandbox not verified by root harness",
    win32: "Native Windows validation required",
    darwin: "Native macOS validation required",
  },
  serverBackupEnabled: false,
};
if (manifest.version !== "0.1.0") {
  const { stats } = JSON.parse(await fs.readFile("artifacts/desktop/personal-packaged-results.json", "utf8"));
  assert.equal(stats.expected, 2); assert.equal(stats.unexpected, 0); assert.equal(stats.flaky, 0); assert.equal(stats.skipped, 0);
  assert.ok(Date.parse(stats.startTime) >= Date.parse(manifest.createdAt));
  proof.personalRuntime = { packagedLinux: true, cases: 2, networkDisabled: true, accountRequired: false, serverRequired: false, restartAndCloseFlush: true, directoryIsolation: true, noAutomaticUpload: true };
}
const binaryChecks = [];
const applicationName=manifest.applicationName;
assert.equal(applicationName, "ANote");
for (const item of manifest.packages) {
  const base = directory + "/"+applicationName+"-" + item.platform + "-" + item.arch,
    executable =
      item.platform === "darwin"
        ? base + "/"+applicationName+".app/Contents/MacOS/"+applicationName
        : base + "/"+applicationName + (item.platform === "win32" ? ".exe" : "");
  const handle = await fs.open(executable, "r"),
    header = Buffer.alloc(4096);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (item.platform === "linux") {
    assert.equal(header.toString("ascii", 1, 4), "ELF");
    assert.equal(header.readUInt16LE(18), 62);
  } else if (item.platform === "win32") {
    assert.equal(header.toString("ascii", 0, 2), "MZ");
    const pe = header.readUInt32LE(60);
    assert.equal(header.readUInt16LE(pe + 4), 0x8664);
  } else {
    assert.equal(header.readUInt32LE(0), 0xfeedfacf);
    assert.equal(
      header.readUInt32LE(4),
      item.arch === "arm64" ? 0x100000c : 0x1000007,
    );
  }
  binaryChecks.push({
    platform: item.platform,
    arch: item.arch,
    headerVerified: true,
  });
}
proof.binaryHeaders = binaryChecks;
await fs.mkdir("artifacts/reports", { recursive: true });
await fs.writeFile(
  "artifacts/reports/desktop-release-evidence.json",
  JSON.stringify(proof, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    version: manifest.version,
    packages: manifest.packages.length,
    linuxRuntime: true,
    downloads: true,
    windowsMacNative: "user testing pending",
  }),
);

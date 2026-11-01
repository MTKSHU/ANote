import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
const origin = process.env.BASE_URL;
assert.equal((await fetch(origin + "/api/client-releases")).status, 401);
const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    }),
  }).then((r) => r.json()),
  headers = { Authorization: "Bearer " + login.token };
try {
  const manifest = await fetch(origin + "/api/client-releases", {
    headers,
  }).then((r) => r.json());
  assert.equal(manifest.packages.length, 4);
  assert.equal(manifest.signed, false);
  assert.equal(
    (await fetch(origin + "/api/client-releases/not-a-package", { headers }))
      .status,
    404,
  );
  for (const item of manifest.packages) {
    const response = await fetch(origin + item.url, {
      headers: { ...headers, Range: "bytes=0-31" },
    });
    assert.equal(response.status, 206);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, 32);
    assert.equal(
      response.headers.get("content-range"),
      `bytes 0-31/${item.bytes}`,
    );
    assert.ok(
      response.headers.get("content-disposition").startsWith("attachment"),
    );
    if (item.file.endsWith(".zip"))
      assert.equal(bytes.toString("ascii", 0, 2), "PK");
    else assert.deepEqual(bytes.subarray(0, 2), Buffer.from([31, 139]));
  }
  const linux = manifest.packages.find((item) => item.platform === "linux"),
    response = await fetch(origin + linux.url, { headers }),
    hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  assert.equal(bytes, linux.bytes);
  assert.equal(hash.digest("hex"), linux.sha256);
  const evidence = {
    verifiedAt: new Date().toISOString(),
    serverOrigin: new URL(origin).origin,
    authenticatedDownloads: true,
    unauthenticatedRejected: true,
    rangeAllFour: true,
    linuxFullDownloadHashMatched: true,
    manifest,
  };
  await fs.mkdir("/workspace/artifacts/deployment", { recursive: true });
  await fs.writeFile(
    "/workspace/artifacts/deployment/client-download-evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log("Four client downloads and Linux full checksum verified");
} finally {
  await fetch(origin + "/api/auth/logout", { method: "POST", headers });
}

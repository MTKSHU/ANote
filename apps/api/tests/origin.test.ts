import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { requestSecurity } from "../src/request-security.js";

async function server(
  publicOrigin: string,
  run: (origin: string) => Promise<void>,
) {
  const app = express();
  app.use(requestSecurity(publicOrigin));
  app.post("/api/auth/login", (_req, res) =>
    res.status(201).json({ accepted: true }),
  );
  const instance = createServer(app);
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  try {
    await run(`http://127.0.0.1:${(instance.address() as AddressInfo).port}`);
  } finally {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      instance.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
test("HTTPS 反向代理的显式入口和直接内网访问均可提交登录", async () => {
  await server("https://notes.example.org/", async (origin) => {
    for (const requestOrigin of ["https://notes.example.org", origin]) {
      const response = await fetch(origin + "/api/auth/login", {
        method: "POST",
        headers: { Origin: requestOrigin },
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
  });
});
test("跨站、opaque 和伪造 forwarded 来源仍然被拒绝", async () => {
  await server("https://notes.example.org", async (origin) => {
    for (const supplied of [
      "https://untrusted.example",
      "https://notes.example.org.untrusted.example",
      "null",
      "https://notes.example.org/path",
    ]) {
      const response = await fetch(origin + "/api/auth/login", {
        method: "POST",
        headers: {
          Origin: supplied,
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": new URL(supplied === "null" ? origin : supplied)
            .host,
        },
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "请求来源不匹配" });
    }
  });
});
test("未配置外部入口时拒绝 HTTPS 代理来源，保留直接访问与 Bearer 客户端", async () => {
  await server("", async (origin) => {
    assert.equal(
      (
        await fetch(origin + "/api/auth/login", {
          method: "POST",
          headers: {
            Origin: "https://notes.example.org",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "notes.example.org",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/auth/login", {
          method: "POST",
          headers: { Origin: origin },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await fetch(origin + "/api/auth/login", {
          method: "POST",
          headers: {
            Origin: "anote://app",
            Authorization: "Bearer test-client",
          },
        })
      ).status,
      201,
    );
  });
});
test("配置只接受有效的 HTTP(S) origin", () => {
  for (const supplied of [
    "null",
    "file:///tmp/test",
    "https://notes.example.org/path",
    "https://user:password@notes.example.org",
    "https://notes.example.org?query=1",
  ])
    assert.throws(() => requestSecurity(supplied), /PUBLIC_ORIGIN/);
});

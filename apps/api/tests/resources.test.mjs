import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
const origin = process.env.BASE_URL || "http://anote.internal:3000",
  proof = "artifacts/server/resources-proof.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let account, space, viewer, outsider, asset, task;
async function api(
  endpoint,
  method = "GET",
  body,
  auth = account,
  status = 200,
) {
  const res = await fetch(origin + "/api/" + endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer " + auth.token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(res.status, status, method + " " + endpoint);
  return res.json();
}
async function chunk(
  upload,
  bytes,
  offset = upload.offset,
  expected = 200,
  auth = account,
) {
  const res = await fetch(origin + `/api/uploads/${upload.id}/chunk`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + auth.token,
      "Content-Type": "application/octet-stream",
      "Upload-Offset": String(offset),
      "X-Chunk-SHA256": hash(bytes),
    },
    body: bytes,
  });
  assert.equal(res.status, expected, "chunk");
  return res.json();
}
async function begin(filename, bytes) {
  return api(
    "uploads",
    "POST",
    { space_id: space, filename, bytes: bytes.length, hash: hash(bytes) },
    account,
    201,
  );
}
if (process.env.RESOURCE_PHASE === "resume") {
  test("500 MiB 资源在 API/数据库重启后续传，整文件及 Range 校验一致", async () => {
    ({ account, space, task } = JSON.parse(await fs.readFile(proof, "utf8")));
    let current = await api(`uploads/${task.id}`);
    assert.equal(current.offset, 48 * 1024 ** 2);
    const block = Buffer.alloc(16 * 1024 ** 2, 0x5a),
      total = 500 * 1024 ** 2,
      start = Date.now();
    while (current.offset < total)
      current = await chunk(
        current,
        block.subarray(0, Math.min(block.length, total - current.offset)),
      );
    const result = await api(
      `uploads/${task.id}/complete`,
      "POST",
      {},
      account,
      201,
    );
    assert.equal(result.bytes, total);
    assert.equal(result.hash, task.hash);
    const duplicate = await api(
      `uploads/${task.id}/complete`,
      "POST",
      {},
      account,
      201,
    );
    assert.equal(result.id, duplicate.id);
    const response = await fetch(origin + result.url, {
      headers: { Authorization: "Bearer " + account.token },
    });
    assert.equal(response.status, 200);
    const digest = createHash("sha256");
    let received = 0;
    for await (const piece of response.body) {
      digest.update(piece);
      received += piece.length;
    }
    assert.equal(received, total);
    assert.equal(digest.digest("hex"), task.hash);
    const range = await fetch(origin + result.url, {
      headers: {
        Authorization: "Bearer " + account.token,
        Range: "bytes=524287000-524287999",
      },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1000);
    assert.equal(
      range.headers.get("content-range"),
      "bytes 524287000-524287999/524288000",
    );
    await fs.writeFile(
      "artifacts/server/large-transfer-evidence.json",
      JSON.stringify(
        {
          bytes: total,
          resumedFrom: 48 * 1024 ** 2,
          hash: task.hash,
          seconds: (Date.now() - start) / 1000,
          downloadHashMatched: true,
          rangeMatched: true,
          restartRecovered: true,
        },
        null,
        2,
      ),
    );
  });
} else {
  test("资源上传按成员隔离，校验分块并支持幂等重试", async () => {
    account = await api(
      "auth/login",
      "POST",
      {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD,
      },
      null,
      201,
    );
    space = (
      await api(
        "spaces",
        "POST",
        { name: "资源验收 " + randomUUID().slice(0, 8) },
        account,
        201,
      )
    ).id;
    const users = [];
    for (const role of ["viewer", "outsider"]) {
      const username = role + "-" + randomUUID().slice(0, 8),
        password = randomBytes(16).toString("hex");
      const user = await api(
        "users",
        "POST",
        { username, password, name: role },
        account,
        201,
      );
      const auth = await api(
        "auth/login",
        "POST",
        { username, password },
        null,
        201,
      );
      users.push(auth);
      if (role === "viewer")
        await api(
          `spaces/${space}/members`,
          "POST",
          { user_id: user.id, role: "viewer" },
          account,
          201,
        );
    }
    [viewer, outsider] = users;
    const bytes = Buffer.from("剧本：第一场\n研究资源。");
    task = await begin("研究剧本.md", bytes);
    await api(
      "uploads",
      "POST",
      { space_id: space, filename: "..\\escape", bytes: 1, hash: hash(bytes) },
      account,
      400,
    );
    await api(
      "uploads",
      "POST",
      {
        space_id: space,
        filename: "x",
        bytes: 40 * 1024 ** 3,
        hash: hash(bytes),
      },
      account,
      413,
    );
    await api(
      "uploads",
      "POST",
      {
        space_id: space,
        filename: "x",
        bytes: bytes.length,
        hash: hash(bytes),
      },
      viewer,
      403,
    );
    await api(`uploads/${task.id}`, "GET", undefined, viewer, 404);
    await api(`uploads/${task.id}/complete`, "POST", {}, account, 409);
    const wrong = await fetch(origin + `/api/uploads/${task.id}/chunk`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + account.token,
        "Content-Type": "application/octet-stream",
        "Upload-Offset": "0",
        "X-Chunk-SHA256": "0".repeat(64),
      },
      body: bytes,
    });
    assert.equal(wrong.status, 422);
    assert.equal((await api(`uploads/${task.id}`)).offset, 0);
    await chunk(task, bytes);
    await chunk(task, bytes, 0);
    await chunk(task, Buffer.from("different"), 0, 409);
    asset = await api(`uploads/${task.id}/complete`, "POST", {}, account, 201);
    assert.equal(asset.kind, "text");
    assert.equal(asset.hash, hash(bytes));
    await api(`assets/${asset.id}`, "GET", undefined, outsider, 403);
    assert.equal(
      (await api(`assets?space_id=${space}`, "GET", undefined, viewer)).length,
      1,
    );
    const res = await fetch(origin + asset.url, {
      headers: { Authorization: "Bearer " + viewer.token, Range: "bytes=0-8" },
    });
    assert.equal(res.status, 206);
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      bytes.subarray(0, 9),
    );
    assert.equal((await fetch(origin + asset.url)).status, 401);
    assert.equal(
      (
        await fetch(origin + asset.url, {
          headers: {
            Authorization: "Bearer " + account.token,
            Range: "bytes=999999-",
          },
        })
      ).status,
      416,
    );
  });
  test("元数据并发修改可见冲突，归档保留原件，上传可取消", async () => {
    const saved = await api(
      `assets/${asset.id}`,
      "PATCH",
      {
        revision: asset.revision,
        title: "第一场·剧本",
        tags: ["剧本", "入门"],
        description: "团队共享文本",
      },
      account,
    );
    await api(
      `assets/${asset.id}`,
      "PATCH",
      { revision: asset.revision, title: "过期修改" },
      account,
      409,
    );
    await api(
      `assets/${asset.id}`,
      "PATCH",
      { revision: saved.revision, title: "越权修改" },
      viewer,
      403,
    );
    assert.equal(
      (await api(`assets?space_id=${space}&q=${encodeURIComponent("入门")}`))[0]
        .title,
      "第一场·剧本",
    );
    const archived = await api(`assets/${asset.id}`, "PATCH", {
      revision: saved.revision,
      archived: true,
    });
    assert.equal((await api(`assets?space_id=${space}`)).length, 0);
    assert.equal(
      (await api(`assets?space_id=${space}&archived=true`)).length,
      1,
    );
    assert.equal(
      (
        await fetch(origin + asset.url, {
          headers: { Authorization: "Bearer " + account.token },
        })
      ).status,
      200,
    );
    await api(`assets/${asset.id}`, "PATCH", {
      revision: archived.revision,
      archived: false,
    });
    const cancelled = await begin("cancelled.txt", Buffer.from("cancel"));
    await api(`uploads/${cancelled.id}`, "DELETE");
    await chunk(cancelled, Buffer.from("cancel"), 0, 409);
  });
  test("中途断连不提交不完整分块，真实媒体后台解析与缩略图可读取", async () => {
    const content = Buffer.alloc(1024 ** 2, 0x61),
      upload = await begin("interrupted.txt", content);
    await new Promise((resolve) => {
      const req = http.request(
        new URL(`/api/uploads/${upload.id}/chunk`, origin),
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer " + account.token,
            "Content-Type": "application/octet-stream",
            "Upload-Offset": "0",
            "X-Chunk-SHA256": hash(content),
            "Content-Length": String(content.length),
          },
        },
      );
      req.on("error", () => resolve());
      req.write(content.subarray(0, 10000));
      setTimeout(() => req.destroy(), 150);
    });
    await delay(200);
    assert.equal((await api(`uploads/${upload.id}`)).offset, 0);
    await chunk(upload, content);
    await api(`uploads/${upload.id}/complete`, "POST", {}, account, 201);
    for (const filename of ["sample.mp4", "sample.wav", "sample.png"]) {
      const bytes = await fs.readFile("artifacts/server/fixtures/" + filename),
        task = await begin(filename, bytes);
      await chunk(task, bytes);
      const item = await api(
        `uploads/${task.id}/complete`,
        "POST",
        {},
        account,
        201,
      );
      let detail;
      for (let i = 0; i < 120; i++) {
        detail = await api(`assets/${item.id}`);
        if (
          detail.jobs[0]?.status === "complete" ||
          detail.jobs[0]?.status === "failed"
        )
          break;
        await delay(500);
      }
      assert.equal(detail.jobs[0].status, "complete", filename + " parse");
      if (item.kind !== "audio") {
        assert.ok(detail.metadata.width > 0);
        const thumb = await fetch(origin + `/api/assets/${item.id}/thumbnail`, {
          headers: { Authorization: "Bearer " + viewer.token },
        });
        assert.equal(thumb.status, 200);
        assert.equal(thumb.headers.get("content-type"), "image/jpeg");
        assert.ok((await thumb.arrayBuffer()).byteLength > 100);
      } else assert.ok(detail.metadata.duration > 0);
    }
  });
  test("500 MiB 任务写入前三个分块，留下重启续传证据", async () => {
    const total = 500 * 1024 ** 2,
      block = Buffer.alloc(16 * 1024 ** 2, 0x5a),
      digest = createHash("sha256");
    for (let offset = 0; offset < total; offset += block.length)
      digest.update(block.subarray(0, Math.min(block.length, total - offset)));
    task = await api(
      "uploads",
      "POST",
      {
        space_id: space,
        filename: "500MiB-video-container.bin",
        bytes: total,
        hash: digest.digest("hex"),
      },
      account,
      201,
    );
    for (let i = 0; i < 3; i++) task = await chunk(task, block);
    assert.equal(task.offset, 48 * 1024 ** 2);
    await fs.writeFile(proof, JSON.stringify({ account, space, task }), {
      mode: 0o600,
    });
  });
}

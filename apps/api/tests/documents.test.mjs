import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import fs from 'node:fs/promises';
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { schema } from "@anote/document-model";
import { findAnchor } from "@anote/document-model/anchors";
const origin = process.env.BASE_URL || "http://anote.internal:3000";
const peers = [];
let admin, alice, bob, carol, viewer, outsider, space, id, a, b, v, review;
async function api(method, endpoint, body, account, status = 200) {
  const response = await fetch(origin + "/api/" + endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(account ? { Authorization: "Bearer " + account.token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
  assert.equal(
    response.status,
    status,
    method + " " + endpoint + " unexpected status",
  );
  return response.json();
}
async function poll(fn, check) {
  for (let count = 0; count < 150; count++) {
    const value = await fn();
    if (check(value)) return value;
    await delay(50);
  }
  throw new Error("Remote document did not converge");
}
function json(doc) {
  return JSON.parse(
    JSON.stringify(
      initProseMirrorDoc(doc.getXmlFragment("default"), schema).doc.toJSON(),
    ),
  );
}
function update(doc, value) {
  const fragment = doc.getXmlFragment("default"),
    { meta } = initProseMirrorDoc(fragment, schema);
  doc.transact(() =>
    updateYFragment(doc, fragment, schema.nodeFromJSON(value), meta),
  );
}
async function open(account) {
  const document = new Y.Doc();
  let provider;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider?.destroy();
      reject(new Error("Collaboration connection timed out"));
    }, 12000);
    provider = new HocuspocusProvider({
      url: origin.replace(/^http/, "ws") + "/collab",
      name: id,
      document,
      token: account.token,
      onSynced: ({ state }) => {
        if (state) {
          clearTimeout(timer);
          resolve();
        }
      },
      onAuthenticationFailed: () => {
        clearTimeout(timer);
        reject(new Error("Collaboration authorization failed"));
      },
    });
  });
  peers.push({ provider, document });
  return document;
}
after(() => {
  for (const peer of peers) {
    peer.provider.destroy();
    peer.document.destroy();
  }
});
test("真实账号的文档创建、目录与跨知识库权限", async () => {
  admin = await api(
    "POST",
    "auth/login",
    {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    },
    null,
    201,
  );
  space = (
    await api(
      "POST",
      "spaces",
      { name: "协作集成 " + randomUUID().slice(0, 6) },
      admin,
      201,
    )
  ).id;
  const accounts = {};
  for (const role of ["alice", "bob", "carol", "viewer", "outsider"]) {
    const username = role + "-" + randomUUID().slice(0, 8),
      password = randomBytes(18).toString("hex"),
      created = await api(
        "POST",
        "users",
        { username, password, name: role },
        admin,
        201,
      );
    accounts[role] = await api(
      "POST",
      "auth/login",
      { username, password },
      null,
      201,
    );
    if (role !== "outsider")
      await api(
        "POST",
        `spaces/${space}/members`,
        {
          user_id: created.id,
          role:
            role === "viewer"
              ? "viewer"
              : role === "carol"
                ? "reviewer"
                : "editor",
        },
        admin,
        201,
      );
  }
  [alice, bob, carol, viewer, outsider] = [
    "alice",
    "bob",
    "carol",
    "viewer",
    "outsider",
  ].map((key) => accounts[key]);
  id = (
    await api(
      "POST",
      "documents",
      { space_id: space, title: "场景重建笔记",visibility:"team" },
      alice,
      201,
    )
  ).id;
  await api(
    "POST",
    "documents",
    { space_id: space, title: "非法新建",visibility:"team" },
    viewer,
    403,
  );
  await api("GET", `documents/${id}`, undefined, outsider, 403);
  const value = await api("GET", `documents/${id}`, undefined, viewer);
  assert.equal(value.role, "viewer");
  const exported = await api("GET", `documents/${id}/export`, undefined, alice);
  await api(
    "POST",
    `documents/${id}/import`,
    { opId: randomUUID(), markdown: exported.markdown },
    alice,
  );
});
test("真实 WebSocket 双编辑者收敛，只读连接不能写入", async () => {
  a = await open(alice);
  b = await open(bob);
  v = await open(viewer);
  const initial = json(a);
  initial.content.unshift({type:"heading",attrs:{level:1,blockId:randomUUID()},content:[{type:"text",text:"场景重建笔记"}]});
  initial.content[1].content = [{ type: "text", text: "场景重建观察。" }];
  update(a, initial);
  await poll(
    () => json(b),
    (value) => JSON.stringify(value).includes("场景重建观察。"),
  );
  const first = a.getXmlFragment("default").toArray()[0].toArray()[0],
    second = b.getXmlFragment("default").toArray()[1].toArray()[0];
  first.insert(first.length, " Alice 补充");
  second.insert(second.length, " Bob 补充");
  await poll(
    () => json(a),
    (value) => JSON.stringify(value).includes("Bob 补充"),
  );
  await poll(
    () => json(b),
    (value) => JSON.stringify(value).includes("Alice 补充"),
  );
  const before = await api("GET", `documents/${id}`, undefined, alice);
  const bad = json(v);
  bad.content[1].content = [{ type: "text", text: "只读连接非法写入" }];
  update(v, bad);
  await delay(300);
  const current = await api("GET", `documents/${id}`, undefined, alice);
  assert.deepEqual(current.snapshot, before.snapshot);
});
test("评论线程、回复、解决与重开，审核绑定不可变快照", async () => {
  const anchor = findAnchor(a, "场景重建观察");
  assert.ok(anchor);
  const comment = await api(
    "POST",
    `documents/${id}/comments`,
    { anchor, text: "请补充配置", author: outsider.user.id },
    alice,
    201,
  );
  assert.equal(comment.author, alice.user.id);
  await api(
    "POST",
    `documents/${id}/comments`,
    { parent_id: comment.id, text: "配置已记录" },
    bob,
    201,
  );
  await api(
    "POST",
    `documents/${id}/comments`,
    { parent_id: comment.id, text: "只读用户回复" },
    viewer,
    403,
  );
  assert.equal(
    (
      await api(
        "PATCH",
        `documents/${id}/comments/${comment.id}`,
        { resolved: true },
        bob,
      )
    ).resolved,
    true,
  );
  assert.equal(
    (
      await api(
        "PATCH",
        `documents/${id}/comments/${comment.id}`,
        { resolved: false },
        alice,
      )
    ).resolved,
    false,
  );
  const before = await api("GET", `documents/${id}`, undefined, alice);
  review = await api(
    "POST",
    `documents/${id}/reviews`,
    { reviewer: carol.user.id },
    alice,
    201,
  );
  await api(
    "POST",
    `documents/${id}/reviews/${review.id}/decision`,
    { status: "approved" },
    bob,
    403,
  );
  await api(
    "POST",
    `documents/${id}/reviews/${review.id}/decision`,
    { status: "approved", comment: "通过，补充下一轮实验" },
    carol,
    201,
  );
  const next = json(a);
  next.content[1].content.push({ type: "text", text: " 审核后的新草稿" });
  update(a, next);
  await poll(
    () => api("GET", `documents/${id}`, undefined, alice),
    (value) => JSON.stringify(value.snapshot).includes("审核后的新草稿"),
  );
  const records = await api("GET", `documents/${id}/reviews`, undefined, alice);
  assert.equal(records[0].status, "approved");
  assert.equal(records[0].hash, review.hash);
  assert.deepEqual(records[0].snapshot, before.snapshot);
});
test("Markdown 三方合并、幂等与冲突，不接受其他账号的基准", async () => {
  const base = await api("GET", `documents/${id}/export`, undefined, alice),
    opId = randomUUID(),
    markdown = base.markdown.replace(
      "场景重建观察。",
      "场景重建观察。本地 Markdown 补充。",
    );
  const current = json(b);
  current.content[0].content.push({ type: "text", text: " 线上标题更新" });
  update(b, current);
  await poll(
    () => json(a),
    (value) => JSON.stringify(value).includes("线上标题更新"),
  );
  await api("POST", `documents/${id}/import`, { opId, markdown }, alice);
  const replay = await api(
    "POST",
    `documents/${id}/import`,
    { opId, markdown },
    alice,
  );
  assert.equal(replay.replayed, true);
  const merged = await api("GET", `documents/${id}`, undefined, alice);
  assert.equal(
    JSON.stringify(merged.snapshot).includes("本地 Markdown 补充"),
    true,
  );
  assert.equal(JSON.stringify(merged.snapshot).includes("线上标题更新"), true);
  const foreign = await api("GET", `documents/${id}/export`, undefined, bob);
  await api(
    "POST",
    `documents/${id}/import`,
    { opId: randomUUID(), markdown: foreign.markdown },
    alice,
    409,
  );
  const conflictBase = await api(
    "GET",
    `documents/${id}/export`,
    undefined,
    alice,
  );
  const remote = json(b);
  remote.content[1].content = [{ type: "text", text: "线上 Mesh 研究" }];
  update(b, remote);
  await poll(
    () => json(a),
    (value) => JSON.stringify(value).includes("线上 Mesh 研究"),
  );
  const before = await api("GET", `documents/${id}`, undefined, alice);
  const local = conflictBase.markdown.replace(
    /场景重建观察。[^\n]*/,
    "本地 NeRF 研究",
  );
  const conflicted = await api(
    "POST",
    `documents/${id}/import`,
    { opId: randomUUID(), markdown: local },
    alice,
    409,
  );
  assert.equal(conflicted.applied, false);
  assert.deepEqual(
    (await api("GET", `documents/${id}`, undefined, alice)).snapshot,
    before.snapshot,
  );
});
test("版本恢复检查当前哈希并同步到在线编辑者，评论失效和审核快照保留", async () => {
  const versions = await api(
      "GET",
      `documents/${id}/versions`,
      undefined,
      alice,
    ),
    oldest = versions.at(-1),
    version = await api(
      "GET",
      `documents/${id}/versions/${oldest.id}`,
      undefined,
      alice,
    );
  await api(
    "POST",
    `documents/${id}/versions/${oldest.id}/restore`,
    { expectedHash: "stale" },
    alice,
    409,
  );
  const current = await api("GET", `documents/${id}`, undefined, alice);
  await api(
    "POST",
    `documents/${id}/versions/${oldest.id}/restore`,
    { expectedHash: current.hash },
    alice,
    201,
  );
  await poll(
    () => json(a),
    (value) => isDeepStrictEqual(value, version.snapshot),
  );
  await poll(
    () => json(b),
    (value) => isDeepStrictEqual(value, version.snapshot),
  );
  const comments = await api(
    "GET",
    `documents/${id}/comments`,
    undefined,
    alice,
  );
  assert.equal(
    comments.filter((c) => !c.parent_id)[0].resolvedAnchor.orphaned,
    true,
  );
  const reviews = await api("GET", `documents/${id}/reviews`, undefined, alice);
  assert.equal(reviews[0].hash, review.hash);
  assert.equal(reviews[0].status, "approved");
  await fs.mkdir('artifacts/server',{recursive:true});
  await fs.writeFile('artifacts/server/documents-proof.json',JSON.stringify({id,session:alice,snapshot:version.snapshot,reviewHash:review.hash},null,2),{mode:0o600});
});

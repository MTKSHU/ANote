import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { schema } from "@anote/document-model";
const origin = process.env.BASE_URL || "http://anote.internal:3000";
async function call(method, path, body, account, status = 200) {
  const r = await fetch(origin + "/api/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(account ? { Authorization: "Bearer " + account.token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, status, method + " " + path);
  return r.json();
}
async function poll(fn, check) {
  for (let i = 0; i < 160; i++) {
    const value = await fn();
    if (check(value)) return value;
    await delay(100);
  }
  throw new Error("Expected server state was not reached");
}
test("个人与团队知识库、嵌套目录、指定共享及分钟历史快照", async (t) => {
  const admin = await call(
      "POST",
      "auth/login",
      {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD,
      },
      null,
      201,
    ),
    people = [];
  for (const label of ["alice", "bob"]) {
    const username = "book-" + randomUUID().slice(0, 10),
      password = randomBytes(18).toString("hex");
    await call(
      "POST",
      "users",
      { username, password, name: label },
      admin,
      201,
    );
    people.push(
      await call("POST", "auth/login", { username, password }, null, 201),
    );
  }
  const [alice, bob] = people,
    personal = await call(
      "POST",
      "spaces",
      { name: "个人课题 " + randomUUID(), kind: "personal" },
      alice,
      201,
    ),
    team = await call(
      "POST",
      "spaces",
      { name: "团队课题 " + randomUUID(), kind: "team" },
      admin,
      201,
    );
  for (const account of people)
    await call(
      "POST",
      `spaces/${team.id}/members`,
      { user_id: account.user.id, role: "editor" },
      admin,
      201,
    );
  let root, child, note;
  await t.test(
    "个人知识库可自行创建，管理员与其他成员不能读取整个知识库",
    async () => {
      await call(
        "POST",
        "spaces",
        { name: "越权团队库", kind: "team" },
        alice,
        403,
      );
      assert.equal(personal.kind, "personal");
      assert.ok(
        (await call("GET", "spaces", undefined, alice)).some(
          (s) => s.id === personal.id,
        ),
      );
      for (const actor of [bob, admin]) {
        assert.equal(
          (await call("GET", "spaces", undefined, actor)).some(
            (s) => s.id === personal.id,
          ),
          false,
        );
        await call(
          "GET",
          `spaces/${personal.id}/folders`,
          undefined,
          actor,
          403,
        );
        await call(
          "GET",
          `documents?space_id=${personal.id}`,
          undefined,
          actor,
          403,
        );
      }
      await call(
        "POST",
        `spaces/${personal.id}/members`,
        { user_id: bob.user.id, role: "viewer" },
        alice,
        400,
      );
      await call(
        "PATCH",
        `spaces/${personal.id}`,
        { name: "私人实验知识库", description: "研究材料" },
        alice,
      );
      await call(
        "POST",
        "documents",
        { space_id: personal.id, title: "不应全团队公开", visibility: "team" },
        alice,
        400,
      );
    },
  );
  await t.test("目录层级、重命名与移动校验，笔记可移动并保留正文", async () => {
    root = await call(
      "POST",
      `spaces/${personal.id}/folders`,
      { name: "研究项目" },
      alice,
      201,
    );
    child = await call(
      "POST",
      `spaces/${personal.id}/folders`,
      { name: "实验记录", parent_id: root.id },
      alice,
      201,
    );
    note = await call(
      "POST",
      "documents",
      { space_id: personal.id, folder_id: child.id, title: "个人实验记录" },
      alice,
      201,
    );
    assert.equal(note.visibility, "private");
    await call("GET", `documents/${note.id}`, undefined, admin, 403);
    await call(
      "PATCH",
      `spaces/${personal.id}/folders/${root.id}`,
      { parent_id: child.id },
      alice,
      409,
    );
    await call(
      "PATCH",
      `spaces/${personal.id}/folders/${child.id}`,
      { name: "对比实验" },
      alice,
    );
    await call("PATCH", `documents/${note.id}`, { folder_id: root.id }, alice);
    assert.equal(
      (await call("GET", `documents/${note.id}`, undefined, alice)).folder_id,
      root.id,
    );
    const foreign = await call(
      "POST",
      `spaces/${team.id}/folders`,
      { name: "另一个知识库目录" },
      admin,
      201,
    );
    await call(
      "PATCH",
      `documents/${note.id}`,
      { folder_id: foreign.id },
      alice,
      400,
    );
    const list = await call("GET", "spaces", undefined, alice),
      book = list.find((s) => s.id === personal.id);
    assert.equal(book.folder_count, 2);
    assert.equal(book.note_count, 1);
  });
  await t.test(
    "单篇共享不开放个人库目录；分享给我仅返回被邀请的笔记",
    async () => {
      const hidden = await call(
        "POST",
        "documents",
        { space_id: personal.id, title: "未分享的研究记录" },
        alice,
        201,
      );
      const share = await call(
        "GET",
        `documents/${note.id}/sharing`,
        undefined,
        alice,
      );
      assert.ok(
        (
          await call(
            "GET",
            `documents/${note.id}/share-candidates`,
            undefined,
            alice,
          )
        ).some((u) => u.id === bob.user.id),
      );
      await call(
        "PATCH",
        `documents/${note.id}/sharing`,
        {
          visibility: "private",
          access_revision: share.access_revision,
          collaborators: [{ user_id: bob.user.id, role: "editor" }],
        },
        alice,
      );
      assert.equal(
        (await call("GET", `documents/${note.id}`, undefined, bob)).role,
        "editor",
      );
      await call("GET", `spaces/${personal.id}/folders`, undefined, bob, 403);
      await call("GET", `documents/${hidden.id}`, undefined, bob, 403);
      const list = await call("GET", "documents", undefined, bob),
        invited = list.find((n) => n.id === note.id);
      assert.equal(invited.collaboration_role, "editor");
      assert.equal(invited.space_kind, "personal");
      await call(
        "PATCH",
        `documents/${note.id}`,
        { folder_id: child.id },
        bob,
        403,
      );
      const bytes = Buffer.from("personal note attachment"),
        hash = createHash("sha256").update(bytes).digest("hex");
      const task = await call(
        "POST",
        "uploads",
        {
          space_id: personal.id,
          doc_id: note.id,
          filename: "note.txt",
          bytes: bytes.length,
          hash,
        },
        bob,
        201,
      );
      const sent = await fetch(origin + `/api/uploads/${task.id}/chunk`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + bob.token,
          "Upload-Offset": "0",
          "X-Chunk-SHA256": hash,
        },
        body: bytes,
      });
      assert.equal(sent.status, 200);
      const asset = await call(
        "POST",
        `uploads/${task.id}/complete`,
        {},
        bob,
        201,
      );
      await call("GET", `assets/${asset.id}`, undefined, alice);
      await call("GET", `assets/${asset.id}`, undefined, admin, 403);
    },
  );
  await t.test("停止编辑后仍自动保留分钟快照，无变化不重复生成", async () => {
    const document = new Y.Doc();
    let provider;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS timeout")), 15000);
        provider = new HocuspocusProvider({
          url: origin.replace(/^http/, "ws") + "/collab",
          name: note.id,
          document,
          token: alice.token,
          onSynced: ({ state }) => {
            if (state) {
              clearTimeout(timer);
              resolve();
            }
          },
        });
      });
      const fragment = document.getXmlFragment("default"),
        { meta } = initProseMirrorDoc(fragment, schema);
      updateYFragment(
        document,
        fragment,
        schema.nodeFromJSON({
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { blockId: randomUUID(), textAlign: "center" },
              content: [{ type: "text", text: "停止输入后的最终记录" }],
            },
          ],
        }),
        meta,
      );
      await poll(
        () => call("GET", `documents/${note.id}`, undefined, alice),
        (v) => JSON.stringify(v.snapshot).includes("停止输入后的最终记录"),
      );
      const pool = new Pool({
        host: "db",
        database: "anote",
        user: "anote",
        password: process.env.DB_PASSWORD,
      });
      try {
        await pool.query(
          "UPDATE document_versions SET created_at=now()-interval '65 seconds' WHERE doc_id=$1",
          [note.id],
        );
      } finally {
        await pool.end();
      }
      const versions = await poll(
        () => call("GET", `documents/${note.id}/versions`, undefined, alice),
        (v) => v.some((s) => s.source === "automatic"),
      );
      const saved = await call(
        "GET",
        `documents/${note.id}/versions/${versions.find((v) => v.source === "automatic").id}`,
        undefined,
        alice,
      );
      assert.match(JSON.stringify(saved.snapshot), /停止输入后的最终记录/);
      assert.equal(saved.snapshot.content[0].attrs.textAlign, "center");
      await delay(6000);
      assert.equal(
        (await call("GET", `documents/${note.id}/versions`, undefined, alice))
          .length,
        versions.length,
      );
    } finally {
      provider?.destroy();
      document.destroy();
    }
  });
});

import { test } from "node:test";
import { Pool } from "pg";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.status, status, method + " " + path);
  return r.json();
}
async function open(account, id) {
  let provider;
  const document = new Y.Doc();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS timeout")), 10000);
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
        reject(new Error("WS rejected"));
      },
    });
  });
  return { document, provider };
}
async function upload(account, space, doc, text = "private file") {
  const bytes = Buffer.from(text),
    hash = createHash("sha256").update(bytes).digest("hex");
  const task = await call(
    "POST",
    "uploads",
    {
      space_id: space,
      doc_id: doc,
      filename: "secret.txt",
      bytes: bytes.length,
      hash,
    },
    account,
    201,
  );
  const res = await fetch(origin + `/api/uploads/${task.id}/chunk`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + account.token,
      "Upload-Offset": "0",
      "X-Chunk-SHA256": hash,
    },
    body: bytes,
  });
  assert.equal(res.status, 200);
  return call("POST", `uploads/${task.id}/complete`, {}, account, 201);
}
test("笔记隐私、附件隔离、协作者撤销、外链访问范围与失效", async (t) => {
  const admin = await call(
    "POST",
    "auth/login",
    {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    },
    null,
    201,
  );
  const space = (
    await call(
      "POST",
      "spaces",
      { name: "隐私验收 " + randomUUID() },
      admin,
      201,
    )
  ).id;
  const accounts = [];
  for (const role of ["editor", "editor", "reviewer", "viewer"]) {
    const username = "p-" + randomUUID().slice(0, 12),
      password = randomBytes(18).toString("hex");
    const u = await call(
      "POST",
      "users",
      { username, password, name: role },
      admin,
      201,
    );
    await call(
      "POST",
      `spaces/${space}/members`,
      { user_id: u.id, role },
      admin,
      201,
    );
    accounts.push(
      await call("POST", "auth/login", { username, password }, null, 201),
    );
  }
  const [owner, peer, reviewer, viewer] = accounts;
  const doc = await call(
      "POST",
      "documents",
      { space_id: space, title: "私有实验" },
      owner,
      201,
    ),
    id = doc.id;
  const asset = await upload(owner, space, id),
    other = (
      await call(
        "POST",
        "documents",
        { space_id: space, title: "另一个私有笔记" },
        owner,
        201,
      )
    ).id;
  const otherAsset = await upload(owner, space, other, "other private file");
  await t.test(
    "新笔记默认私有，阅读成员也能创建个人笔记；管理员不能越过私有权限",
    async () => {
      assert.equal(doc.visibility, "private");
      assert.equal(
        (
          await call(
            "POST",
            "documents",
            { space_id: space, title: "阅读成员个人笔记" },
            viewer,
            201,
          )
        ).visibility,
        "private",
      );
      for (const account of [peer, reviewer, viewer, admin]) {
        assert.equal(
          (
            await call(
              "GET",
              `documents?space_id=${space}&q=私有实验`,
              undefined,
              account,
            )
          ).length,
          0,
        );
        for (const suffix of [
          "",
          "/export",
          "/versions",
          "/comments",
          "/reviews",
          "/conflicts",
        ])
          await call(
            "GET",
            `documents/${id}${suffix}`,
            undefined,
            account,
            403,
          );
        await call("GET", `assets/${asset.id}`, undefined, account, 403);
        assert.equal(
          (
            await call("GET", `assets?space_id=${space}`, undefined, account)
          ).some((a) => a.id === asset.id),
          false,
        );
      }
    },
  );
  await t.test("附件检索分页不截断，并过滤其他成员的私有附件", async () => {
    for (let i = 0; i < 42; i++)
      await upload(owner, space, id, "search fixture " + i);
    const first = await call(
      "GET",
      `documents/${id}/assets/search?q=secret&kind=text`,
      undefined,
      owner,
    );
    assert.equal(first.items.length, 40);
    assert.equal(first.nextOffset, 40);
    const second = await call(
      "GET",
      `documents/${id}/assets/search?q=secret&kind=text&offset=40`,
      undefined,
      owner,
    );
    assert.equal(second.items.length, 4);
    assert.equal(second.nextOffset, null);
    assert.equal(
      new Set([...first.items, ...second.items].map((a) => a.id)).size,
      44,
    );
    const personal = await call(
      "POST",
      "documents",
      { space_id: space, title: "检索隔离" },
      peer,
      201,
    );
    assert.equal(
      (
        await call(
          "GET",
          `documents/${personal.id}/assets/search?q=secret`,
          undefined,
          peer,
        )
      ).items.length,
      0,
    );
  });
  let ownerWS, peerWS;
  const sharing = async (
    collaborators,
    visibility = "private",
    only_me = false,
  ) => {
    const current = await call(
      "GET",
      `documents/${id}/sharing`,
      undefined,
      owner,
    );
    return call(
      "PATCH",
      `documents/${id}/sharing`,
      {
        visibility,
        collaborators,
        access_revision: current.access_revision,
        only_me,
      },
      owner,
    );
  };
  try {
    await t.test(
      "指定编辑与审核成员可协作；撤销现有连接后停止接收后续更新",
      async () => {
        await sharing([
          { user_id: peer.user.id, role: "editor" },
          { user_id: reviewer.user.id, role: "reviewer" },
          { user_id: viewer.user.id, role: "reviewer" },
        ]);
        const eligible = await call(
          "GET",
          `documents/${id}/sharing`,
          undefined,
          peer,
        );
        assert.ok(eligible.reviewers.some((u) => u.id === viewer.user.id));
        assert.ok(!eligible.reviewers.some((u) => u.id === peer.user.id));
        await call(
          "POST",
          `documents/${id}/reviews`,
          { reviewer: viewer.user.id },
          owner,
          201,
        );
        ownerWS = await open(owner, id);
        peerWS = await open(peer, id);
        const d = ownerWS.document,
          fragment = d.getXmlFragment("default"),
          value = initProseMirrorDoc(fragment, schema).doc.toJSON();
        value.content = [
          {
            type: "paragraph",
            attrs: { blockId: randomUUID() },
            content: [{ type: "text", text: "协作正文" }],
          },
          {
            type: "mediaResource",
            attrs: {
              blockId: randomUUID(),
              assetId: asset.id,
              src: asset.url,
              title: asset.title,
              localPath: `assets/${asset.id}.txt`,
              kind: "text",
              mime: asset.mime,
              bytes: asset.bytes,
              hash: asset.hash,
            },
          },
        ];
        await call(
          "POST",
          `documents/${id}/assets`,
          { asset_ids: [asset.id] },
          owner,
          201,
        );
        updateYFragment(
          d,
          fragment,
          schema.nodeFromJSON(value),
          initProseMirrorDoc(fragment, schema).meta,
        );
        for (
          let i = 0;
          i < 50 &&
          !JSON.stringify(
            initProseMirrorDoc(
              peerWS.document.getXmlFragment("default"),
              schema,
            ).doc.toJSON(),
          ).includes("协作正文");
          i++
        )
          await delay(100);
        assert.match(
          JSON.stringify(
            initProseMirrorDoc(
              peerWS.document.getXmlFragment("default"),
              schema,
            ).doc.toJSON(),
          ),
          /协作正文/,
        );
        await call(
          "POST",
          `documents/${id}/reviews`,
          { reviewer: reviewer.user.id },
          owner,
          201,
        );
        await call(
          "PATCH",
          `documents/${id}`,
          { title: "非法改名" },
          reviewer,
          403,
        );
        await sharing([]);
        await delay(200);
        const old = Y.encodeStateAsUpdate(peerWS.document);
        fragment.toArray()[0].toArray()[0].insert(0, "撤销后的私有修改");
        await delay(600);
        assert.deepEqual(Y.encodeStateAsUpdate(peerWS.document), old);
        await call("GET", `documents/${id}`, undefined, peer, 403);
      },
    );
    await t.test(
      "附件复用建立独立权限副本；团队可见和外部只读分享不泄漏其他私有附件",
      async () => {
        const clone = (
          await call(
            "POST",
            `documents/${other}/assets`,
            { asset_ids: [asset.id] },
            owner,
            201,
          )
        )[0];
        assert.notEqual(clone.id, asset.id);
        await sharing([], "team");
        await call("GET", `documents/${id}`, undefined, peer);
        await call("GET", `assets/${asset.id}`, undefined, peer);
        await call("GET", `assets/${clone.id}`, undefined, peer, 403);
        await sharing([]);
        const expired = await call(
          "POST",
          `documents/${id}/sharing/links`,
          { days: 1 },
          owner,
          201,
        );
        const pool = new Pool({
          host: "db",
          database: "anote",
          user: "anote",
          password: process.env.DB_PASSWORD,
        });
        try {
          await pool.query(
            "UPDATE document_share_links SET expires_at=now()-interval '1 second' WHERE id=$1",
            [expired.id],
          );
        } finally {
          await pool.end();
        }
        await call(
          "GET",
          "public/notes/" + expired.path.split("/").pop(),
          undefined,
          null,
          404,
        );
        await call(
          "POST",
          `documents/${id}/sharing/links`,
          { days: 365 },
          owner,
          400,
        );
        const link = await call(
            "POST",
            `documents/${id}/sharing/links`,
            { days: 1 },
            owner,
            201,
          ),
          token = link.path.split("/").pop();
        let pub = await call("GET", `public/notes/${token}`);
        assert.equal(pub.title, "私有实验");
        assert.equal(pub.space_id, undefined);
        assert.equal(pub.comments, undefined);
        assert.match(
          JSON.stringify(pub.snapshot),
          new RegExp("/api/public/notes/" + token + "/assets/" + asset.id),
        );
        const r = await fetch(
          origin + `/api/public/notes/${token}/assets/${asset.id}`,
          { headers: { Range: "bytes=0-6" } },
        );
        assert.equal(r.status, 206);
        assert.equal(await r.text(), "private");
        await call(
          "GET",
          `public/notes/${token}/assets/${otherAsset.id}`,
          undefined,
          null,
          404,
        );
        await call(
          "DELETE",
          `documents/${id}/sharing/links/${link.id}`,
          undefined,
          owner,
        );
        await call("GET", `public/notes/${token}`, undefined, null, 404);
        await call(
          "GET",
          `public/notes/${token}/assets/${asset.id}`,
          undefined,
          null,
          404,
        );
        const again = await call(
          "POST",
          `documents/${id}/sharing/links`,
          { days: 7 },
          owner,
          201,
        );
        await sharing([{ user_id: peer.user.id, role: "viewer" }]);
        await sharing([], "private", true);
        await call(
          "GET",
          "public/notes/" + again.path.split("/").pop(),
          undefined,
          null,
          404,
        );
        await call("GET", `documents/${id}`, undefined, peer, 403);
      },
    );
  } finally {
    ownerWS?.provider.destroy();
    peerWS?.provider.destroy();
    ownerWS?.document.destroy();
    peerWS?.document.destroy();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { initProseMirrorDoc } from "@tiptap/y-tiptap";
import { schema } from "@anote/document-model";
const origin = process.env.BASE_URL || "http://anote.internal:3000";
async function api(endpoint, method = "GET", data, token) {
  const response = await fetch(origin + "/api/" + endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  assert.ok(response.ok, endpoint + " " + response.status);
  return response.json();
}
test(
  "30 个独立账号同时协作，小笔记的全部修改收敛且服务端持久化",
  { timeout: 120000 },
  async () => {
    const admin = await api("auth/login", "POST", {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD,
      }),
      space = await api(
        "spaces",
        "POST",
        { name: "30 成员验证 " + randomUUID().slice(0, 6) },
        admin.token,
      );
    const accounts = [];
    for (let i = 0; i < 30; i++) {
      const username = "load-" + randomUUID().slice(0, 10),
        password = randomBytes(16).toString("hex"),
        user = await api(
          "users",
          "POST",
          { username, password, name: "并发成员 " + i },
          admin.token,
        );
      await api(
        `spaces/${space.id}/members`,
        "POST",
        { user_id: user.id, role: "editor" },
        admin.token,
      );
      accounts.push(await api("auth/login", "POST", { username, password }));
    }
    const doc = await api(
        "documents",
        "POST",
        { space_id: space.id, title: "30 成员协作验收", visibility: "team" },
        admin.token,
      ),
      peers = [];
    try {
      const start = Date.now();
      await Promise.all(
        accounts.map(
          (account) =>
            new Promise((resolve, reject) => {
              const document = new Y.Doc(),
                timer = setTimeout(
                  () => reject(new Error("connect timeout")),
                  20000,
                ),
                provider = new HocuspocusProvider({
                  url: origin.replace(/^http/, "ws") + "/collab",
                  name: doc.id,
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
                    reject(new Error("auth failed"));
                  },
                });
              peers.push({ provider, document });
            }),
        ),
      );
      const connected = Date.now();
      const paragraph = peers[0].document.getXmlFragment("default").get(0),
        initialText = new Y.XmlText();
      initialText.insert(0, "协作测试：");
      paragraph.insert(0, [initialText]);
      for (
        let i = 0;
        i < 100 &&
        !peers.every(
          (p) =>
            p.document.getXmlFragment("default").get(0).get(0) instanceof
            Y.XmlText,
        );
        i++
      )
        await new Promise((r) => setTimeout(r, 50));
      peers.forEach(({ document }, i) => {
        const paragraph = document.getXmlFragment("default").get(0),
          text = paragraph.get(0);
        assert.ok(text instanceof Y.XmlText);
        document.transact(() => text.insert(text.length, `【成员${i}】`));
      });
      let value;
      for (let i = 0; i < 200; i++) {
        value = await api(`documents/${doc.id}`, "GET", undefined, admin.token);
        const server = JSON.stringify(value.snapshot),
          expected = JSON.stringify(
            initProseMirrorDoc(
              peers[0].document.getXmlFragment("default"),
              schema,
            ).doc.toJSON(),
          );
        if (
          peers.every(({ document }) => {
            const body = JSON.stringify(
              initProseMirrorDoc(
                document.getXmlFragment("default"),
                schema,
              ).doc.toJSON(),
            );
            return (
              body === expected &&
              accounts.every((_, index) => body.includes(`【成员${index}】`))
            );
          }) &&
          accounts.every((_, index) => server.includes(`【成员${index}】`))
        )
          break;
        await delay(50);
      }
      const target = JSON.stringify(value.snapshot);
      for (let i = 0; i < 30; i++)
        assert.equal(target.split(`【成员${i}】`).length - 1, 1);
      for (const { document } of peers)
        assert.equal(
          JSON.stringify(
            initProseMirrorDoc(
              document.getXmlFragment("default"),
              schema,
            ).doc.toJSON(),
          ),
          target,
        );
      await fs.writeFile(
        "artifacts/server/capacity-evidence.json",
        JSON.stringify(
          {
            users: 30,
            connections: 30,
            smallDocument: true,
            connectSeconds: (connected - start) / 1000,
            convergeSeconds: (Date.now() - connected) / 1000,
            allEditsPersisted: true,
            scope:
              "one small note, 30 independent authenticated WebSocket clients; not a throughput or long-duration SLA",
          },
          null,
          2,
        ),
      );
    } finally {
      for (const { provider, document } of peers) {
        provider.destroy();
        document.destroy();
      }
    }
  },
);

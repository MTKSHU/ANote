import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasdoorLogin } from "../../apps/desktop/main/casdoor-login.mjs";
import { SessionStore } from "../../apps/desktop/main/session-store.mjs";
const base = process.env.BASE_URL || "http://anote.internal:3000";
async function api(endpoint, data, token, method = "POST") {
  const response = await fetch(base + "/api/" + endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, endpoint + ": " + response.status);
  return result;
}
async function control(sub) {
  assert.equal(
    (
      await fetch("http://casdoor-mock:4400/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sub,
          name: "原生客户端成员",
          preferred_username: "admin",
          mode: "normal",
        }),
      })
    ).ok,
    true,
  );
}
async function browser(url) {
  const cookies = new Map();
  for (let i = 0; i < 10; i++) {
    const origin = new URL(url).origin;
    const response = await fetch(url, {
      redirect: "manual",
      headers: cookies.has(origin) ? { Cookie: cookies.get(origin) } : {},
    });
    const values = response.headers.getSetCookie();
    if (values.length)
      cookies.set(
        origin,
        values.map((value) => value.split(";")[0]).join("; "),
      );
    const target = response.headers.get("location");
    if (!target) return;
    url = new URL(target, url).href;
  }
  throw new Error("Redirect loop");
}
test("desktop system-browser callback, verified identity, credential storage isolation and explicit binding", async () => {
  const admin = await api("auth/login", {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  });
  const sub = "native-utility-" + randomUUID();
  await control(sub);
  const client = new CasdoorLogin(browser);
  const result = await client.connect({ serverURL: base });
  const team = await api("team", undefined, admin.token, "GET");
  const member = team.members.find(
    (m) => m.id === result.user.id && m.membership_status === "active",
  );
  assert.ok(member);
  assert.equal(member.is_admin, false);
  assert.equal(result.user.id, member.id);
  assert.equal(client.cancel, null);
  const root = await mkdtemp(path.join(os.tmpdir(), "anote-sso-"));
  try {
    const store = await new SessionStore(root, {
      isAsyncEncryptionAvailable: () => false,
    }).load();
    await store.acceptSession(base, result);
    assert.equal(store.settings.user.id, member.id);
    assert.equal(store.settings.validationMode, false);
    const profile = store.profileKey;
    await store.acceptSession(base, admin);
    assert.notEqual(store.profileKey, profile);
    await store.acceptSession(base, result);
    assert.equal(store.profileKey, profile);
    await control("link-native-" + randomUUID());
    const local = await api(
      "users",
      {
        username: "native-bind-" + randomUUID().slice(0, 8),
        name: "客户端本地账号",
        password: "Native-password-test-123!",
      },
      admin.token,
    );
    const localSession = await api("auth/login", {
      username: local.username,
      password: "Native-password-test-123!",
    });
    const linked = await client.connect(
      { serverURL: base, intent: "link" },
      localSession.token,
    );
    assert.equal(linked.user.id, local.id);
    const relogin = await client.connect({ serverURL: base });
    assert.equal(relogin.user.id, local.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("desktop cancellation closes the temporary callback listener", async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  const client = new CasdoorLogin(async () => {
    ready();
  });
  const pending = client.connect({ serverURL: base });
  pending.catch(() => {});
  await opened;
  assert.equal(typeof client.cancel, "function");
  client.cancel();
  await assert.rejects(pending, /已取消/);
  assert.equal(client.cancel, null);
});

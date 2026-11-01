import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
const origin = process.env.BASE_URL || "http://anote.internal:3000";
const proof = "artifacts/server/foundation-proof.json";
async function call(method, endpoint, body, token, status = 200, extra = {}) {
  const response = await fetch(origin + "/api/" + endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    response.status,
    status,
    `${method} ${endpoint}: unexpected status`,
  );
  const data = await response.json();
  return { data, response };
}
const signIn = async (username, password) =>
  await call("POST", "auth/login", { username, password }, null, 201);
let admin, editor, viewer, outsider, space, parent, child, editorCredentials;
if (process.env.PERSISTENCE_ONLY === "1") {
  test("正式迁移和账号、目录、权限在应用与数据库重启后保留", async () => {
    const saved = JSON.parse(await fs.readFile(proof, "utf8"));
    const { data: login } = await signIn(saved.username, saved.password);
    const { data: spaces } = await call(
      "GET",
      "spaces",
      undefined,
      login.token,
    );
    assert.equal(
      spaces.some((s) => s.id === saved.space && s.role === "editor"),
      true,
    );
    const { data: folders } = await call(
      "GET",
      `spaces/${saved.space}/folders`,
      undefined,
      login.token,
    );
    assert.equal(
      folders.some((folder) => folder.id === saved.parent),
      true,
    );
    assert.equal(
      folders.find((folder) => folder.id === saved.child)?.parent_id,
      saved.parent,
    );
  });
} else {
  test("独立账号登录、Cookie 和不暴露密码的成员接口", async () => {
    const { data: health } = await call("GET", "health");
    assert.equal(health.mode, "workspace");
    const { data, response } = await signIn(
      process.env.ADMIN_USERNAME,
      process.env.ADMIN_PASSWORD,
    );
    admin = data;
    assert.equal(admin.user.is_admin, true);
    const cookie = response.headers.get("set-cookie") || "";
    assert.equal(cookie.includes("HttpOnly"), true);
    assert.equal(cookie.includes("SameSite=Strict"), true);
    const { data: current } = await call(
      "GET",
      "auth/session",
      undefined,
      admin.token,
    );
    assert.equal(current.user.id, admin.user.id);
    await call(
      "POST",
      "auth/login",
      { username: process.env.ADMIN_USERNAME, password: "incorrect-password" },
      null,
      401,
    );
    const { data: users } = await call("GET", "users", undefined, admin.token);
    assert.equal(JSON.stringify(users).includes("password_hash"), false);
    assert.equal(
      JSON.stringify(users).includes(process.env.ADMIN_PASSWORD),
      false,
    );
  });
  test("管理员添加成员并赋予知识库角色，未授权成员不能读目录", async () => {
    for (const role of ["editor", "viewer", "outsider"]) {
      const credentials = {
        username: `${role}-${randomUUID().slice(0, 8)}`,
        password: " " + randomBytes(18).toString("hex") + " ",
      };
      const { data: created } = await call(
        "POST",
        "users",
        { ...credentials, name: "测试成员 " + role },
        admin.token,
        201,
      );
      assert.equal(created.is_admin, false);
      const { data: account } = await signIn(
        credentials.username,
        credentials.password,
      );
      if (role === "editor") {
        editor = account;
        editorCredentials = credentials;
      } else if (role === "viewer") viewer = account;
      else outsider = account;
    }
    const { data: spaces } = await call(
      "GET",
      "spaces",
      undefined,
      admin.token,
    );
    space = spaces[0].id;
    await call(
      "POST",
      `spaces/${space}/members`,
      { user_id: editor.user.id, role: "editor" },
      admin.token,
      201,
    );
    await call(
      "POST",
      `spaces/${space}/members`,
      { user_id: viewer.user.id, role: "viewer" },
      admin.token,
      201,
    );
    await call(
      "GET",
      `spaces/${space}/folders`,
      undefined,
      outsider.token,
      403,
    );
    const { data: outsiderSpaces } = await call(
      "GET",
      "spaces",
      undefined,
      outsider.token,
    );
    assert.deepEqual(outsiderSpaces, []);
    await call("GET", "users", undefined, editor.token, 403);
    await call(
      "POST",
      "users",
      { username: "forged-admin", password: "irrelevant", is_admin: true },
      viewer.token,
      403,
    );
  });
  test("目录创建和移动校验权限、父目录所属与循环结构", async () => {
    parent = (
      await call(
        "POST",
        `spaces/${space}/folders`,
        { name: "AI 训练笔记" },
        editor.token,
        201,
      )
    ).data.id;
    child = (
      await call(
        "POST",
        `spaces/${space}/folders`,
        { name: "对比实验", parent_id: parent },
        editor.token,
        201,
      )
    ).data.id;
    await call(
      "POST",
      `spaces/${space}/folders`,
      { name: "非法目录" },
      viewer.token,
      403,
    );
    await call(
      "PATCH",
      `spaces/${space}/folders/${parent}`,
      { parent_id: child },
      editor.token,
      409,
    );
    const other = (
      await call("POST", "spaces", { name: "独立知识库" }, admin.token, 201)
    ).data;
    const elsewhere = (
      await call(
        "POST",
        `spaces/${other.id}/folders`,
        { name: "私有目录" },
        admin.token,
        201,
      )
    ).data;
    await call(
      "PATCH",
      `spaces/${space}/folders/${child}`,
      { parent_id: elsewhere.id },
      editor.token,
      400,
    );
    const { data: folders } = await call(
      "GET",
      `spaces/${space}/folders`,
      undefined,
      viewer.token,
    );
    assert.equal(
      folders.find((folder) => folder.id === child)?.parent_id,
      parent,
    );
  });
  test("并发移动目录不会产生循环", async () => {
    const left = (
        await call(
          "POST",
          `spaces/${space}/folders`,
          { name: "并发左目录" },
          editor.token,
          201,
        )
      ).data.id,
      right = (
        await call(
          "POST",
          `spaces/${space}/folders`,
          { name: "并发右目录" },
          editor.token,
          201,
        )
      ).data.id;
    const results = await Promise.all(
      [
        [left, right],
        [right, left],
      ].map(async ([id, parent]) => {
        const response = await fetch(
          `${origin}/api/spaces/${space}/folders/${id}`,
          {
            method: "PATCH",
            headers: {
              Authorization: "Bearer " + editor.token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ parent_id: parent }),
            signal: AbortSignal.timeout(10000),
          },
        );
        return response.status;
      }),
    );
    assert.deepEqual(results.sort(), [200, 409]);
  });
  test("无效会话、跨来源 Cookie 请求、伪造成员角色被拒绝", async () => {
    await call("GET", "spaces", undefined, "invalid", 401);
    await call("POST", "spaces", { name: "跨站创建" }, null, 403, {
      Origin: "https://untrusted.example",
      Cookie: "anote_session=" + admin.token,
    });
    await call(
      "POST",
      `spaces/${space}/members`,
      { user_id: viewer.user.id, role: "owner" },
      admin.token,
      400,
    );
    await call(
      "POST",
      `spaces/${space}/members`,
      { user_id: viewer.user.id, role: "admin" },
      viewer.token,
      403,
    );
    await call(
      "POST",
      `spaces/${space}/members`,
      { user_id: admin.user.id, role: null },
      admin.token,
      409,
    );
  });
  test("退出登录使原令牌立即失效，保留重启验证样本", async () => {
    await call("POST", "auth/logout", {}, viewer.token, 201);
    await call("GET", "spaces", undefined, viewer.token, 401);
    await fs.mkdir("artifacts/server", { recursive: true });
    await fs.writeFile(
      proof,
      JSON.stringify({ ...editorCredentials, space, parent, child }, null, 2),
      { mode: 0o600 },
    );
  });
}

import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Pool } from "pg";
import { api, admin, login } from "./helpers";
test.describe("OIDC 平台认证", () => {
  test.skip(
    process.env.CASDOOR_TEST !== "1",
    "Requires isolated mock identity provider",
  );
  const base = process.env.BASE_URL || "http://anote.internal:3000",
    password = "OIDC-local-test-password-123!";
  async function control(request: any, values: any = {}) {
    const sub = "oidc-" + randomUUID();
    await request.post("http://casdoor-mock:4400/control", {
      data: {
        sub,
        name: "统一认证用户",
        email: sub + "@example.test",
        preferred_username: "admin",
        mode: "normal",
        ...values,
      },
    });
  }
  test("反向代理 Host 和转发头不改变固定回调", async ({ request }) => {
    const r = await request.get("/api/auth/casdoor/start", {
      maxRedirects: 0,
      headers: {
        Host: "upstream.invalid:3000",
        "X-Forwarded-Host": "evil.invalid",
      },
    });
    const next = new URL(r.headers().location);
    expect(next.origin).toBe(base);
    const auth = await request.get(next.href, {
      maxRedirects: 0,
      headers: { Host: "upstream.invalid:3000" },
    });
    expect(
      new URL(auth.headers().location).searchParams.get("redirect_uri"),
    ).toBe(base + "/api/auth/casdoor/callback");
  });
  test("已验证邮箱首次登录关联原账号、原笔记和团队，provider 管理员标识不提权", async ({
    request,
    page,
  }) => {
    const root = await admin(request),
      username = "mail-" + randomUUID().slice(0, 8),
      email = username + "@example.test",
      local = await api(
        request,
        "POST",
        "users",
        { username, name: "原账号", password },
        root,
      );
    await api(
      request,
      "PATCH",
      `team/members/${local.id}`,
      { email, email_verified: true },
      root,
    );
    const account = await api(request, "POST", "auth/login", {
      username,
      password,
    });
    const library = await api(
        request,
        "POST",
        "spaces",
        { kind: "personal", name: "旧笔记库" },
        account,
      ),
      note = await api(
        request,
        "POST",
        "documents",
        { space_id: library.id, title: "已有研究笔记" },
        account,
      ),
      team = await api(
        request,
        "POST",
        "teams",
        { name: "已有研究团队" },
        account,
      );
    const before = (await api(request, "GET", "team", undefined, root)).members
      .length;
    await control(request, { email });
    await page.goto("/");
    await page.getByRole("link", { name: "使用 Casdoor 统一登录" }).click();
    await expect(
      page.getByRole("button", { name: "ANote", exact: true }),
    ).toBeVisible();
    const current = await page.evaluate(async () =>
      fetch("/api/auth/session").then((r) => r.json()),
    );
    expect(current.user.id).toBe(local.id);
    expect(current.user.is_admin).toBe(false);
    expect(
      (await api(request, "GET", "team", undefined, root)).members.length,
    ).toBe(before);
    expect(
      (await api(request, "GET", `documents/${note.id}`, undefined, current))
        .title,
    ).toBe("已有研究笔记");
    expect(
      (await api(request, "GET", "teams", undefined, current)).some(
        (t: any) => t.id === team.id,
      ),
    ).toBe(true);
    await api(request, "GET", "admin/settings", undefined, current, 403);
  });
  test("新 OIDC 用户为普通用户，密码仅由身份服务管理", async ({
    request,
    page,
  }) => {
    const root = await admin(request);
    await control(request);
    await page.goto("/api/auth/casdoor/start");
    await expect(
      page.getByRole("button", { name: "ANote", exact: true }),
    ).toBeVisible();
    const current = await page.evaluate(async () =>
      fetch("/api/auth/session").then((r) => r.json()),
    );
    expect(current.user.is_admin).toBe(false);
    expect(current.user.local_password_enabled).toBe(false);
    expect(current.user.email_verified).toBe(true);
    await api(
      request,
      "PATCH",
      `team/members/${current.user.id}`,
      { password },
      root,
      400,
    );
    await api(
      request,
      "PATCH",
      "me",
      { old_password: "none", password },
      current,
      400,
    );
    expect(await api(request, "GET", "teams", undefined, current)).toEqual([]);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByLabel("昵称", { exact: true }).fill("我的统一认证昵称");
    await settings.getByRole("button", { name: "保存昵称", exact: true }).click();
    await expect(settings.locator(".profile-card h3")).toHaveText("我的统一认证昵称");
    await page.request.post("/api/auth/logout");
    await page.goto("/api/auth/casdoor/start");
    await expect(page.locator(".academic-user")).toContainText("我的统一认证昵称");
    const fresh = await page.request.get("/api/me").then(r => r.json());
    expect(fresh.id).toBe(current.user.id);
    expect(fresh.name).toBe("我的统一认证昵称");
    expect(fresh.local_password_enabled).toBe(false);
  });
  for (const mode of [
    "nonce",
    "audience",
    "issuer",
    "signature",
    "expired",
    "subject",
    "email_unverified",
    "email_missing",
    "email_mismatch",
  ])
    test(`拒绝无效认证或邮箱：${mode}`, async ({ request, page }) => {
      const root = await admin(request),
        before = (await api(request, "GET", "team", undefined, root)).members
          .length;
      await control(request, { mode });
      await page.goto("/api/auth/casdoor/start");
      await expect(page.getByRole("alert")).toBeVisible();
      expect(
        (await api(request, "GET", "team", undefined, root)).members.length,
      ).toBe(before);
    });
  test("浏览器绑定、回调重放和客户端 PKCE 一次性兑换", async ({
    browser,
    request,
  }) => {
    const root = await admin(request),
      username = "native-" + randomUUID().slice(0, 8),
      local = await api(
        request,
        "POST",
        "users",
        { username, name: "原客户端账号", password },
        root,
      ),
      signed = await api(request, "POST", "auth/login", { username, password });
    await control(request);
    const verifier = randomBytes(32).toString("base64url"),
      state = randomBytes(32).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    await api(
      request,
      "POST",
      "auth/casdoor/native/start",
      {
        redirect_uri: "https://evil.test/callback",
        state,
        code_challenge: challenge,
      },
      undefined,
      400,
    );
    const start = await api(
        request,
        "POST",
        "auth/casdoor/native/start",
        {
          redirect_uri: "http://127.0.0.1:45678/callback",
          state,
          code_challenge: challenge,
          intent: "link",
        },
        signed,
      ),
      context = await browser.newContext();
    try {
      const r = await context.request.get(start.url, { maxRedirects: 0 }),
        authorize = r.headers().location;
      expect(authorize).not.toContain("test-secret");
      const auth = await request.get(authorize, { maxRedirects: 0 }),
        callback = auth.headers().location;
      expect(
        (await request.get(callback, { maxRedirects: 0 })).headers().location,
      ).toContain("invalid_response");
      const correct = await context.request.get(callback, { maxRedirects: 0 }),
        dest = new URL(correct.headers().location);
      expect(dest.origin).toBe("http://127.0.0.1:45678");
      expect(dest.searchParams.get("state")).toBe(state);
      expect(dest.searchParams.has("token")).toBe(false);
      const code = dest.searchParams.get("code");
      await api(
        request,
        "POST",
        "auth/casdoor/native/exchange",
        { code, code_verifier: randomBytes(32).toString("base64url") },
        undefined,
        401,
      );
      expect(
        (
          await api(request, "POST", "auth/casdoor/native/exchange", {
            code,
            code_verifier: verifier,
          })
        ).user.id,
      ).toBe(local.id);
      await api(
        request,
        "POST",
        "auth/casdoor/native/exchange",
        { code, code_verifier: verifier },
        undefined,
        401,
      );
      expect(
        (await context.request.get(callback, { maxRedirects: 0 })).headers()
          .location,
      ).toContain("invalid_response");
    } finally {
      await context.close();
    }
  });
  test("加密配置、三种认证模式与当前管理员 OIDC 证明，缺失字段清晰可见", async ({
    request,
    page,
  }) => {
    const originalRoot = await admin(request),
      username = "proof-" + randomUUID().slice(0, 8);
    await api(
      request,
      "POST",
      "users",
      { username, name: "配置测试管理员", password, is_admin: true },
      originalRoot,
    );
    const root = await api(request, "POST", "auth/login", {
        username,
        password,
      }),
      original = await api(request, "GET", "admin/settings", undefined, root);
    try {
      let cfg = await api(
        request,
        "PATCH",
        "admin/settings",
        { auth_mode: "local" },
        root,
      );
      expect(
        (await api(request, "GET", "auth/providers")).casdoor.enabled,
      ).toBe(false);
      await page.goto("/");
      await expect(
        page.getByRole("link", { name: "使用 Casdoor 统一登录" }),
      ).toHaveCount(0);
      await api(
        request,
        "PATCH",
        "admin/settings",
        { auth_mode: "both", oidc_client_id: "" },
        root,
      );
      cfg = await api(request, "GET", "admin/settings", undefined, root);
      expect(cfg.missing_oidc_fields).toContain("oidc_client_id");
      await api(
        request,
        "PATCH",
        "admin/settings",
        {
          auth_mode: "both",
          oidc_client_id: "test-client",
          oidc_secret: "test-secret",
        },
        root,
      );
      cfg = await api(request, "GET", "admin/settings", undefined, root);
      expect(cfg.oidc_secret).toBeUndefined();
      expect(cfg.oidc_secret_configured).toBe(true);
      const db = new Pool({
        host: "db",
        user: "anote",
        database: "anote",
        password: process.env.DB_PASSWORD,
      });
      try {
        const stored = (
          await db.query("SELECT oidc_secret FROM platform_settings")
        ).rows[0].oidc_secret;
        expect(stored).not.toContain("test-secret");
      } finally {
        await db.end();
      }
      await api(
        request,
        "PATCH",
        "admin/settings",
        { auth_mode: "oidc" },
        root,
        409,
      );
      await control(request, {
        email: "root-" + randomUUID() + "@example.test",
      });
      const link = await api(request, "POST", "auth/casdoor/link", {}, root);
      await page.goto(link.url);
      await expect(
        page.getByRole("button", { name: "ANote", exact: true }),
      ).toBeVisible();
      await api(
        request,
        "PATCH",
        "admin/settings",
        { auth_mode: "oidc" },
        root,
      );
      const beforeDomain = await api(
        request,
        "GET",
        "admin/settings",
        undefined,
        root,
      );
      const moved = await api(
        request,
        "PATCH",
        "admin/settings",
        {
          revision: beforeDomain.revision,
          public_origin: "https://notes-moved.example.test",
          site_name: "个人定制名称",
        },
        root,
      );
      expect(moved.auth_mode).toBe("oidc");
      expect(moved.allowed_origins).toContain(beforeDomain.public_origin);
      expect(
        (await request.get("/api/auth/providers").then((r) => r.json())).local,
      ).toBe(false);
      await api(
        request,
        "PATCH",
        "admin/settings",
        {
          revision: moved.revision,
          oidc_client_id: "unproven-new-application",
        },
        root,
        409,
      );
      await api(
        request,
        "PATCH",
        "admin/settings",
        {
          revision: moved.revision,
          public_origin: beforeDomain.public_origin,
          site_name: "ANote",
        },
        root,
      );
      await api(
        request,
        "POST",
        "auth/login",
        {
          username: process.env.ADMIN_USERNAME,
          password: process.env.ADMIN_PASSWORD,
        },
        undefined,
        403,
      );
      const isolated = await page.context().browser()!.newContext();
      try {
        const fresh = await isolated.newPage();
        await fresh.goto(base);
        await expect(
          fresh.getByRole("link", { name: "使用 Casdoor 统一登录" }),
        ).toBeVisible();
        await expect(fresh.getByLabel("密码", { exact: true })).toHaveCount(0);
      } finally {
        await isolated.close();
      }
    } finally {
      const cfg = await api(request, "GET", "admin/settings", undefined, root);
      await api(
        request,
        "PATCH",
        "admin/settings",
        { ...original, revision: cfg.revision },
        root,
      );
    }
  });
});

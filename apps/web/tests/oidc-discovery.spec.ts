import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { admin, api, login } from "./helpers";
test.skip(
  process.env.CASDOOR_TEST !== "1",
  "Requires isolated mock identity service",
);
test("应用 discovery 被拒绝时，配置检查、实际 OIDC 登录与管理员提示共用标准发现地址", async ({
  page,
  request,
}) => {
  const root = await admin(request),
    saved = await api(request, "GET", "admin/settings", undefined, root);
  try {
    await api(
      request,
      "PATCH",
      "admin/settings",
      { oidc_application: "denied-app", auth_mode: "both" },
      root,
    );
    const checked = await api(request, "POST", "admin/oidc/check", {}, root);
    expect(checked.reachable).toBe(true);
    expect(checked.fallback_used).toBe(true);
    expect(checked.discovery_url).toBe(
      "http://casdoor-mock:4400/.well-known/openid-configuration",
    );
    expect(checked.warnings.join(" ")).toContain("Unauthorized operation");
    const sub = "fallback-" + randomUUID();
    await request.post("http://casdoor-mock:4400/control", {
      data: {
        sub,
        email: sub + "@example.test",
        mode: "normal",
        name: "兼容发现用户",
      },
    });
    await page.goto("/api/auth/casdoor/start");
    await expect(
      page.getByRole("button", { name: "ANote", exact: true }),
    ).toBeVisible();
    const current = await page.evaluate(async () =>
      fetch("/api/auth/session").then((r) => r.json()),
    );
    expect(current.user.email).toBe(sub + "@example.test");
    expect(current.user.is_admin).toBe(false);
    await page.context().clearCookies();
    await login(page);
    await page
      .locator(".academic-user")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page
      .getByRole("button", { name: "平台管理", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "检查已保存的 OIDC 配置", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "应用级发现地址不可用",
    );
    await expect(page.getByRole("status")).toContainText(
      "/.well-known/openid-configuration",
    );
    await page.screenshot({
      path: "artifacts/web/oidc-discovery-fallback.png",
    });
  } finally {
    const current = await api(
      request,
      "GET",
      "admin/settings",
      undefined,
      root,
    );
    await api(
      request,
      "PATCH",
      "admin/settings",
      { ...saved, revision: current.revision },
      root,
    );
  }
});
test("应用 metadata issuer 不匹配时明确报错，不回退掩盖错误", async ({
  request,
}) => {
  const root = await admin(request),
    saved = await api(request, "GET", "admin/settings", undefined, root);
  try {
    await api(
      request,
      "PATCH",
      "admin/settings",
      { oidc_application: "wrong-issuer-app" },
      root,
    );
    const result = await api(
      request,
      "POST",
      "admin/oidc/check",
      {},
      root,
      400,
    );
    expect(result.error).toContain("issuer");
  } finally {
    const current = await api(
      request,
      "GET",
      "admin/settings",
      undefined,
      root,
    );
    await api(
      request,
      "PATCH",
      "admin/settings",
      { ...saved, revision: current.revision },
      root,
    );
  }
});

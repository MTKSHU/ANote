import { test, expect } from "@playwright/test";
import { api, login, chooseTheme } from "./helpers";
import { person, grant, origin } from "./mcp-helpers";
test("AI工具链为独立设置标签，自动显示和撤销授权；退出登录常驻设置右侧并撤销会话", async ({ page, request }) => {
  const owner = await person(request), authorization = await grant(request, owner, "notes:read", "入口验证 AI");
  try {
    await login(page, owner); const sidebar = page.locator(".academic-user"), settingsButton = sidebar.getByRole("button", { name: "设置", exact: true }), logout = sidebar.getByRole("button", { name: "退出登录", exact: true });
    await expect(logout).toBeVisible(); const s = (await settingsButton.boundingBox())!, l = (await logout.boundingBox())!;
    expect(l.x).toBeGreaterThanOrEqual(s.x + s.width); expect(Math.abs(l.y - s.y)).toBeLessThan(2);
    await settingsButton.click(); const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings.locator(":scope > nav button")).toHaveText(["账号与偏好", "AI工具链", "桌面客户端"]);
    await expect(settings.locator(".mcp-connections")).toHaveCount(0);
    await settings.getByRole("button", { name: "AI工具链", exact: true }).click();
    await expect(settings.getByLabel("MCP 接入地址", { exact: true })).toHaveValue(origin + "/mcp");
    await expect(settings.locator(".mcp-connection-list")).toContainText("入口验证 AI"); await expect(settings.locator("summary")).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) { await chooseTheme(page, theme); await expect(settings.getByLabel("MCP 接入地址", { exact: true })).toBeVisible(); await page.screenshot({ path: `artifacts/web/settings-ai-${theme}.png` }); }
    await settings.getByRole("button", { name: "复制 Codex 配置", exact: true }).click(); await expect(settings.getByRole("status")).toHaveText("Codex 配置已复制");
    await settings.getByRole("button", { name: "撤销连接", exact: true }).click(); await expect(settings.getByRole("button", { name: "已撤销", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(settings).toHaveCount(0);
    const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === "anote_session"); expect(!!sessionCookie).toBe(true);
    const signedOut = page.waitForResponse(response => response.url().endsWith("/api/auth/logout") && response.request().method() === "POST");
    await logout.click(); const response = await signedOut; expect(response.ok()).toBe(true); await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
    expect((await request.get("/api/me", { headers: { Cookie: "anote_session=" + sessionCookie!.value } })).status()).toBe(401);
  } finally { await authorization.close(); }
});

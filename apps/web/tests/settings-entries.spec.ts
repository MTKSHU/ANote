import { test, expect } from "@playwright/test";
import { api, login, chooseTheme, openWorkspaceSettings } from "./helpers";
import { person, grant, origin } from "./mcp-helpers";
test("用户和消息位于右上角，菜单设置与退出可键盘操作，主题与回收站同一底行", async ({ page, request }) => {
  const owner = await person(request), authorization = await grant(request, owner, "notes:read", "入口验证 AI");
  try {
    await login(page, owner); const top=page.getByRole("group",{name:"用户与消息",exact:true}),menu=top.getByRole("button",{name:"用户菜单",exact:true}),logout=page.getByRole("menuitem",{name:"退出登录",exact:true});
    await expect(top).toBeVisible();const banner=(await page.getByRole('banner',{name:'工作空间顶栏',exact:true}).boundingBox())!;expect((await page.locator(".academic-main").boundingBox())!.y).toBeGreaterThanOrEqual(banner.y+banner.height-1);await expect(top.getByRole("link",{name:"消息通知",exact:true})).toBeVisible();
    const bottom=page.getByRole("navigation",{name:"辅助导航",exact:true}),trash=(await bottom.getByRole("link",{name:/回收站/}).boundingBox())!,theme=(await bottom.getByRole("button",{name:"外观模式",exact:true}).boundingBox())!;expect(Math.abs(trash.y-theme.y)).toBeLessThan(12);
    await menu.focus();await page.keyboard.press("ArrowDown");await expect(menu).toHaveAttribute("aria-expanded","true");await page.keyboard.press("Escape");await expect(menu).toHaveAttribute("aria-expanded","false");
    await menu.click();await page.locator(".academic-page-header h1").click();await expect(menu).toHaveAttribute("aria-expanded","false");
    const settings=await openWorkspaceSettings(page);
    await expect(settings.locator(":scope > nav button")).toHaveText(["账号与偏好", "AI工具链", "桌面客户端"]);
    await expect(settings.locator(".mcp-connections")).toHaveCount(0);
    await settings.getByRole("button", { name: "AI工具链", exact: true }).click();
    await expect(settings.getByLabel("MCP 接入地址", { exact: true })).toHaveValue(origin + "/mcp");
    await expect(settings.locator(".mcp-connection-list")).toContainText("入口验证 AI"); await expect(settings.locator(".mcp-personal-token > summary")).toHaveText('远程 SSH / 无浏览器客户端令牌');
    for (const theme of ["light", "dark"] as const) { await chooseTheme(page, theme); await expect(settings.getByLabel("MCP 接入地址", { exact: true })).toBeVisible(); await page.screenshot({ path: `artifacts/web/settings-ai-${theme}.png` }); }
    await settings.getByRole("button", { name: "复制 Codex 配置", exact: true }).click(); await expect(settings.getByRole("status")).toHaveText("Codex 配置已复制");
    await settings.getByRole("button", { name: "撤销连接", exact: true }).click(); await expect(settings.getByRole("button", { name: "已撤销", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(settings).toHaveCount(0);
    const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === "anote_session"); expect(!!sessionCookie).toBe(true);
    const signedOut = page.waitForResponse(response => response.url().endsWith("/api/auth/logout") && response.request().method() === "POST");
    await menu.click();await logout.click(); const response = await signedOut; expect(response.ok()).toBe(true); await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
    expect((await request.get("/api/me", { headers: { Cookie: "anote_session=" + sessionCookie!.value } })).status()).toBe(401);
  } finally { await authorization.close(); }
});

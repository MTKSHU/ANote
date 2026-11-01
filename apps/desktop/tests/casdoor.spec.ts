import { test, expect, _electron } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
test("Electron 界面经系统浏览器回环完成 OIDC 登录与普通用户身份", async ({
  browser,
  request,
}) => {
  const base = process.env.BASE_URL || "http://anote.internal:3000";
  const sub = "electron-" + randomUUID(),
    profile = path.resolve("artifacts/desktop/casdoor-profiles", randomUUID());
  const signed = await request.post("/api/auth/login", {
    data: {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  expect(signed.ok()).toBeTruthy();
  const admin = await signed.json();
  await request.post("http://casdoor-mock:4400/control", {
    data: {
      sub,
      name: "Electron 统一登录",
      preferred_username: "admin",
      mode: "normal",
    },
  });
  const application = await _electron.launch({
    args: ["--no-sandbox", "apps/desktop"],
    env: {
      ...process.env,
      ANOTE_LOCALE: "zh-CN",
      ANOTE_CLIENT_DATA_DIR: profile,
      ANOTE_DESKTOP_TEST: "1",
    },
  });
  const context = await browser.newContext();
  try {
    // Capture the OS browser opener; the real browser below follows the unmodified server OIDC flow.
    await application.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        (globalThis as any).__casdoorURL = url;
      };
    });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "连接团队空间", exact: true }).click();
    await page.getByLabel("服务地址", { exact: true }).fill(base);
    async function open() {
      await application.evaluate(() => {
        (globalThis as any).__casdoorURL = null;
      });
      await page
        .getByRole("button", { name: "使用 Casdoor 统一登录", exact: true })
        .click();
      await expect
        .poll(() =>
          application.evaluate(() => (globalThis as any).__casdoorURL),
        )
        .toBeTruthy();
      const url = await application.evaluate(
        () => (globalThis as any).__casdoorURL,
      );
      const browserPage = await context.newPage();
      await browserPage.goto(url);
      await browserPage.close();
    }
    await open();
    const team = await request.get("/api/team", {
      headers: { Authorization: "Bearer " + admin.token },
    });
    const member = (await team.json()).members.find(
      (m: any) =>
        m.email === sub + "@example.test" && m.membership_status === "active",
    );
    expect(member).toBeTruthy();
    expect(member.is_admin).toBe(false);
    await expect(
      page.getByRole("button", { name: "ANote", exact: true }),
    ).toBeVisible();
    const state = await page.evaluate(() => window.anote.state());
    expect(state.user?.id).toBe(member.id);
    expect(state.user?.is_admin).toBe(false);
    expect(state.token).toMatch(/^[\w-]{43}$/);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      page.getByText("此账号已绑定 Casdoor。", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "artifacts/desktop/casdoor-login.png" });
  } finally {
    await context.close();
    await application.close();
  }
});

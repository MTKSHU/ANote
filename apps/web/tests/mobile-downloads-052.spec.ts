import { test, expect, request as playwrightRequest } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { api, login, openWorkspaceSettings } from "./helpers";
import { person } from "./mcp-helpers";
const mobileVersion=process.env.ANOTE_MOBILE_TEST_VERSION||"0.5.0",artifactRoot=process.env.ANOTE_MOBILE_ARTIFACT_ROOT||"artifacts/preview-052";

test.beforeEach(async ({ request }) => {
  const response = await request.get("/api/platform/public"), platform = await response.json();
  expect(platform.public_origin).toMatch(/^http:\/\/(?:anote\.internal(?::3000)?|127\.0\.0\.1:\d+|192\.168\.177\.99:\d+)$/);
});
test("网页与桌面共用列表展示三种移动预览，鉴权下载APK且不混入桌面更新", async ({ page, request }) => {
  expect((await request.get("/api/client-releases/mobile")).status()).toBe(401);
  const account = await person(request), catalog = await api(request, "GET", "client-releases/mobile", undefined, account);
  expect(catalog.packages.map((item: any) => [item.platform, item.version, item.signing])).toEqual([["android", mobileVersion==="0.5.0"?mobileVersion+"-preview":mobileVersion, "test"], ["harmonyos", mobileVersion, "unsigned"], ["ios", mobileVersion, "source"]]);
  const desktop = await api(request, "GET", "client-releases?brand=ANote", undefined, account);
  expect(desktop.packages.every((item: any) => !/\.(apk|hap)$/.test(item.file) && item.platform !== "ios")).toBe(true);
  // person() logs in through this fixture's API context and receives its
  // session cookie. Use a genuinely separate cookie jar for anonymous files.
  const guest = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || "http://anote.internal:3000" });
  try { for (const item of catalog.packages) expect((await guest.get(item.url)).status()).toBe(401); } finally { await guest.dispose(); }
  await login(page, account); await openWorkspaceSettings(page); await page.getByRole("button", { name: "桌面客户端", exact: true }).click();
  const section = page.getByRole("region", { name: "移动客户端下载", exact: true }), table = section.getByRole("table", { name: "移动客户端下载", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3); await expect(section).toContainText("未签名 HarmonyOS HAP 需开发环境签名后安装"); await expect(section).toContainText("暂无可分发安装包");
  const apk = catalog.packages[0], download = page.waitForEvent("download"); await table.getByRole("link", { name: "下载 " + apk.file, exact: true }).click(); const item = await download;
  expect(item.suggestedFilename()).toBe(apk.file); const target = path.resolve(artifactRoot,"web/downloads", apk.file); await fs.mkdir(path.dirname(target), { recursive: true }); await item.saveAs(target);
  const bytes = await fs.readFile(target); expect(bytes.length).toBe(apk.bytes); expect(createHash("sha256").update(bytes).digest("hex")).toBe(apk.sha256);
  await expect(table.getByRole("link", { name: "下载 " + catalog.packages[2].file, exact: true })).toHaveText(/下载源工程/);
  await page.screenshot({ path: path.join(artifactRoot,"web/mobile-downloads.png"), animations: "disabled" });
});
test("移动清单暂不可用可独立重试，缺少移动构建时仍保留桌面列表", async ({ page, request }) => {
  const account = await person(request); let attempts = 0;
  await page.route("**/api/client-releases/mobile", route => ++attempts === 1 ? route.fulfill({ status: 503, json: { error: "移动客户端下载资料暂不可用" } }) : route.fulfill({ json: { packages: [] } }));
  await login(page, account); await openWorkspaceSettings(page); await page.getByRole("button", { name: "桌面客户端", exact: true }).click();
  const section = page.getByRole("region", { name: "移动客户端下载", exact: true }); await expect(section.getByRole("status")).toHaveText("移动客户端下载资料暂不可用");
  await section.getByRole("button", { name: "重新读取移动客户端列表", exact: true }).click(); await expect(section).toContainText("服务器暂未提供移动应用安装包");
  await expect(page.getByRole("heading", { name: "桌面客户端", exact: true })).toBeVisible(); expect(attempts).toBe(2);
});

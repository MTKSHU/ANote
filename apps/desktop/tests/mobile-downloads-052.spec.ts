import { test, expect, _electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { api, openWorkspaceSettings } from "../../web/tests/helpers";
import { person } from "../../web/tests/mcp-helpers";

let app: ElectronApplication | undefined;
const mobileVersion=process.env.ANOTE_MOBILE_TEST_VERSION||"0.5.0",artifactRoot=path.join(process.env.ANOTE_MOBILE_ARTIFACT_ROOT||"artifacts/preview-052","desktop");
test.afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });
test("实际桌面包可下载原版本移动预览，APK另存且不触发桌面更新安装", async ({ request }) => {
  const origin = process.env.BASE_URL || "http://anote.internal:3000"; expect(origin).toBe("http://anote.internal:3000");
  expect((await request.get("/api/platform/public").then(response => response.json())).public_origin).toMatch(/^http:\/\/(?:127\.0\.0\.1|192\.168\.177\.99):\d+$/);
  const account = await person(request), catalog = await api(request, "GET", "client-releases/mobile", undefined, account); expect(catalog.packages).toHaveLength(3);
  const executable = path.resolve(process.env.DESKTOP_EXECUTABLE || "artifacts/preview-052/desktop/releases/ANote-linux-x64/ANote"), directory = path.resolve(artifactRoot,"mobile-download-profiles", randomUUID());
  const asar = path.join(path.dirname(executable), "resources/app.asar"), asarSha256 = createHash("sha256").update(await fs.readFile(asar)).digest("hex"); if (process.env.ANOTE_EXPECTED_ASAR_SHA256) expect(asarSha256).toBe(process.env.ANOTE_EXPECTED_ASAR_SHA256);
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ serverURL: origin }));
  app = await _electron.launch({ executablePath: executable, args: ["--no-sandbox", "--password-store=basic"], env: { ...process.env, ANOTE_CLIENT_DATA_DIR: directory, ANOTE_DESKTOP_TEST: "1" } });
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() })); expect(runtime.packaged).toBe(true); expect(runtime.version).toBe(process.env.ANOTE_TEST_DESKTOP_VERSION || "0.5.2");
  const page = await app.firstWindow(); await page.getByRole("button", { name: "连接服务器", exact: true }).click(); await page.getByLabel("服务地址", { exact: true }).fill(origin); await page.getByLabel("用户名", { exact: true }).fill(account.username); await page.getByLabel("密码", { exact: true }).fill(account.password); await page.getByRole("button", { name: "登录并连接", exact: true }).click();
  await openWorkspaceSettings(page); await page.getByRole("button", { name: "客户端更新", exact: true }).click();
  const mobile = page.getByRole("region", { name: "移动客户端下载", exact: true }), table = mobile.getByRole("table", { name: "移动客户端下载", exact: true }); await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").first()).toContainText(mobileVersion==="0.5.0"?mobileVersion+"-preview":mobileVersion); await expect(mobile).toContainText("需开发环境签名后安装"); await expect(mobile).toContainText("源工程，非安装包");
  await page.evaluate(() => window.anote.checkUpdates!());
  await expect.poll(() => page.evaluate(() => window.anote.updateState!().then(value => value.status !== "checking"))).toBe(true);
  const updaterBefore = await page.evaluate(() => window.anote.updateState!()), apk = catalog.packages.find((item: any) => item.platform === "android"), target = path.join(directory, apk.file);
  await app.evaluate(({ BrowserWindow }, target) => { (globalThis as any).__anoteMobileDownloadState = "waiting"; const window = BrowserWindow.getAllWindows()[0]; window.webContents.session.once("will-download", (_event, item) => { item.setSavePath(target); item.once("done", (_event, state) => { (globalThis as any).__anoteMobileDownloadState = state; }); }); }, target);
  await table.getByRole("link", { name: "下载 " + apk.file, exact: true }).click(); await expect.poll(() => app!.evaluate(() => (globalThis as any).__anoteMobileDownloadState)).toBe("completed"); expect((await fs.stat(target)).size).toBe(apk.bytes);
  expect(createHash("sha256").update(await fs.readFile(target)).digest("hex")).toBe(apk.sha256);
  const updaterAfter = await page.evaluate(() => window.anote.updateState!()); for (const key of ["status", "release", "downloadPath", "downloadedBytes"] as const) expect(updaterAfter[key]).toEqual(updaterBefore[key]);
  expect(createHash("sha256").update(await fs.readFile(asar)).digest("hex")).toBe(asarSha256);
  await page.screenshot({ path: path.join(artifactRoot,"mobile-downloads.png"), animations: "disabled" });
  await fs.writeFile(path.join(artifactRoot,"mobile-download-native-evidence.json"), JSON.stringify({ recordedAt: new Date().toISOString(), runtime, asarSha256, mobileFiles: catalog.packages.map((item: any) => ({ file: item.file, version: item.version, signing: item.signing })), actualApkDownload: { bytes: apk.bytes, sha256: apk.sha256, filename: apk.file }, desktopUpdaterUnchanged: true, serverURL: origin }, null, 2) + "\n");
});

test("本地个人模式也显示移动下载入口，未登录可直接跳转连接服务器", async ({ request }) => {
  const origin = process.env.BASE_URL || "http://anote.internal:3000"; expect(origin).toBe("http://anote.internal:3000");
  expect((await request.get("/api/platform/public").then(response => response.json())).public_origin).toMatch(/^http:\/\/(?:127\.0\.0\.1|192\.168\.177\.99):\d+$/);
  const executable = path.resolve(process.env.DESKTOP_EXECUTABLE || "artifacts/preview-052/desktop/releases/ANote-linux-x64/ANote"), directory = path.resolve(artifactRoot,"mobile-local-profiles", randomUUID()), workspace = path.join(directory, "personal");
  await fs.mkdir(workspace, { recursive: true }); await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ serverURL: origin }));
  app = await _electron.launch({ executablePath: executable, args: ["--no-sandbox", "--password-store=basic"], env: { ...process.env, ANOTE_CLIENT_DATA_DIR: directory, ANOTE_DESKTOP_TEST: "1" } });
  await app.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] }); }, workspace);
  const page = await app.firstWindow(), catalogRequests: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname === "/api/client-releases/mobile") catalogRequests.push(request.url()); });
  await page.getByRole("button", { name: "本地个人笔记", exact: true }).click(); await openWorkspaceSettings(page); await page.getByRole("button", { name: "客户端更新", exact: true }).click();
  const mobile = page.getByRole("region", { name: "移动客户端下载", exact: true }); await expect(mobile.getByRole("button", { name: "连接服务器查看移动应用", exact: true })).toBeVisible(); expect(catalogRequests).toEqual([]);
  await mobile.getByRole("button", { name: "连接服务器查看移动应用", exact: true }).click(); await expect(page.getByLabel("服务地址", { exact: true })).toBeVisible(); await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifactRoot,"mobile-download-connect.png"), animations: "disabled" });
});

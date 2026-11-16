import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { admin, api, login } from "./helpers";

async function entry(request: APIRequestContext) {
  const html = await (await request.get("/")).text();
  const value = html.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
  expect(value).toBeTruthy();
  return value!;
}

async function focus(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function focusAndCheck(page: Page, count: () => number) {
  const previous = count();
  await expect.poll(async () => { await focus(page); return count(); }).toBeGreaterThan(previous);
}

test("只在网页构建变化时提醒，保留正在输入的内容，稍后按版本去重", async ({ page, request }) => {
  let current = await entry(request);
  let checks = 0;
  await page.route("**/api/version", async route => {
    checks++;
    await route.fulfill({ json: { build_id: "test", web_entry: current, editor_schema: 8, desktop_version: null } });
  });
  await page.goto("/");
  await expect.poll(() => checks).toBeGreaterThan(0);
  const notice = page.getByRole("status", { name: "平台更新提醒", exact: true });
  await expect(notice).toHaveCount(0);
  const username = page.getByLabel("用户名", { exact: true });
  await username.fill("仍在输入的笔记作者");
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  current = "/assets/index-next_123.js";
  await focusAndCheck(page, () => checks);
  await expect(notice).toBeVisible();
  await expect(username).toHaveValue("仍在输入的笔记作者");
  expect(navigations).toBe(0);
  await notice.getByRole("button", { name: "稍后", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await focusAndCheck(page, () => checks);
  await expect(notice).toHaveCount(0);
  current = "/assets/index-newer123.js";
  await focusAndCheck(page, () => checks);
  await expect(notice).toBeVisible();
  await expect(username).toHaveValue("仍在输入的笔记作者");
  expect(navigations).toBe(0);
});

test("版本检查断网时静默，会话存储不可用时仍可提醒与稍后", async ({ page, request }) => {
  let current = await entry(request);
  let offline = true;
  let checks = 0;
  await page.addInitScript(() => {
    // lib0 reads localStorage while loading collaboration modules. Deny the
    // session storage used by this notice without breaking unrelated startup.
    const session = window.sessionStorage;
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (this === session) throw new Error("Session storage unavailable");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (this === session) throw new Error("Session storage unavailable");
      return set.call(this, key, value);
    };
  });
  await page.route("**/api/version", async route => {
    checks++;
    if (offline) await route.abort("internetdisconnected");
    else await route.fulfill({ json: { web_entry: current } });
  });
  await page.goto("/");
  await expect.poll(() => checks).toBeGreaterThan(0);
  const notice = page.getByRole("status", { name: "平台更新提醒", exact: true });
  await expect(notice).toHaveCount(0);
  offline = false;
  current = "/assets/index-next_456.js";
  await focusAndCheck(page, () => checks);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "稍后", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await focusAndCheck(page, () => checks);
  await expect(notice).toHaveCount(0);
});

test("公开版本端点与已加载网页一致，客户端下载仍需登录", async ({ page, request }) => {
  const response = await request.get("/api/version");
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const value = await response.json();
  expect(Object.keys(value).sort()).toEqual(["build_id", "desktop_version", "editor_schema", "web_entry"]);
  expect(value.web_entry).toBe(await entry(request));
  expect(value.editor_schema).toBe(8);
  expect((await request.get("/api/client-releases")).status()).toBe(401);
  await page.goto("/");
  await expect(page.getByRole("status", { name: "平台更新提醒", exact: true })).toHaveCount(0);
});

test("刷新前保存失败会保留标题草稿，重试成功保存后才刷新", async ({ page, request }) => {
  const root = await admin(request);
  const username = "update-" + randomUUID().slice(0, 8), password = "Update-test-123!";
  await api(request, "POST", "users", { username, password, name: "更新测试作者" }, root);
  const owner = { ...await api(request, "POST", "auth/login", { username, password }), username, password };
  const book = await api(request, "POST", "spaces", { kind: "personal", name: "更新刷新" }, owner);
  const note = await api(request, "POST", "documents", { space_id: book.id, title: "原始标题" }, owner);
  const originalEntry = await entry(request);
  let current = originalEntry;
  await page.route("**/api/version", route => route.fulfill({ json: { web_entry: current } }));
  await login(page, owner);
  await page.goto("/?doc=" + note.id);
  await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
  current = "/assets/index-next_789.js";
  await focus(page);
  const notice = page.getByRole("status", { name: "平台更新提醒", exact: true });
  await expect(notice).toBeVisible();
  let rejected = true;
  await page.route("**/api/documents/" + note.id, async route => {
    if (rejected && route.request().method() === "PATCH")
      await route.fulfill({ status: 503, json: { error: "标题保存失败，请重试" } });
    else await route.continue();
  });
  await page.getByLabel("笔记标题", { exact: true }).fill("刷新前必须保留的标题");
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  await notice.getByRole("button", { name: "保存并刷新", exact: true }).click();
  await expect(notice.getByRole("alert")).toHaveText("标题保存失败，请重试");
  expect(navigations).toBe(0);
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue("刷新前必须保留的标题");
  expect((await api(request, "GET", "documents/" + note.id, undefined, owner)).title).toBe("原始标题");
  rejected = false;
  current = originalEntry;
  await notice.getByRole("button", { name: "保存并刷新", exact: true }).click();
  await expect.poll(() => navigations).toBe(1);
  expect((await api(request, "GET", "documents/" + note.id, undefined, owner)).title).toBe("刷新前必须保留的标题");
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue("刷新前必须保留的标题");
});

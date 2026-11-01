import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import fs from "node:fs/promises";
import { api, admin, login, typeBody, chooseTheme } from "./helpers";

async function person(request: APIRequestContext, root: any, name: string) {
  const username = "history-" + randomUUID().slice(0, 8), password = "History-settings-test-123!";
  await api(request, "POST", "users", { username, password, name }, root);
  return { ...await api(request, "POST", "auth/login", { username, password }), username, password };
}
const pool = () => new Pool({ host: "db", user: "anote", database: "anote", password: process.env.DB_PASSWORD });
async function contrast(locator: Locator) {
  await expect(locator.first()).toBeVisible();
  const values = await locator.evaluateAll(elements => elements.map(element => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
    let bg = [255, 255, 255];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = rgb(getComputedStyle(node).backgroundColor);
      if (value.length === 3 || value[3] === 1) { bg = value; break; }
    }
    const luminance = (value: number[]) => value.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126,.7152,.0722][i], 0);
    const fg = luminance(rgb(getComputedStyle(element).color)), back = luminance(bg);
    return (Math.max(fg, back) + .05) / (Math.min(fg, back) + .05);
  }));
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) expect(value).toBeGreaterThanOrEqual(4.5);
}

test("历史快照记录实际协作昵称，排除阅读者和无修改的保存人，下一版本不继承旧参与者", async ({ page, request, browser }) => {
  const root = await admin(request), a = await person(request, root, "协作甲"), b = await person(request, root, "协作乙"), reader = await person(request, root, "仅阅读者");
  const team = await api(request, "POST", "teams", { name: "版本归属团队" }, root);
  const book = await api(request, "POST", "spaces", { name: "版本协作", kind: "team", team_id: team.id }, root);
  for (const [account, role] of [[a,"editor"],[b,"editor"],[reader,"viewer"]] as const)
    await api(request, "POST", `spaces/${book.id}/members`, { user_id: account.user.id, role }, root);
  const note = await api(request, "POST", "documents", { space_id: book.id, title: "版本参与者" }, a);
  const context = await browser.newContext(), readContext = await browser.newContext(), db = pool();
  try {
    await login(page, a); await page.goto("/?doc=" + note.id);
    const peer = await context.newPage(); await login(peer, b); await peer.goto("/?doc=" + note.id);
    const viewer = await readContext.newPage(); await login(viewer, reader); await viewer.goto("/?doc=" + note.id);
    await expect(viewer.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    await Promise.all([typeBody(page, "甲方修改。"), typeBody(peer, "乙方修改。")]);
    await expect(page.getByTestId("editor")).toContainText("乙方修改");
    await expect.poll(async () => (await db.query("SELECT pending_editor_ids FROM documents WHERE id=$1", [note.id])).rows[0].pending_editor_ids.sort()).toEqual([a.user.id,b.user.id].sort());
    await db.query("UPDATE document_versions SET created_at=now()-interval '61 seconds' WHERE doc_id=$1", [note.id]);
    let automatic: any;
    await expect.poll(async () => {
      automatic = (await api(request, "GET", `documents/${note.id}/versions`, undefined, a)).find((v: any) => ["automatic","collaboration"].includes(v.source));
      return automatic?.editors.map((e: any) => e.id).sort();
    }, { timeout: 12000 }).toEqual([a.user.id,b.user.id].sort());
    await api(request, "PATCH", "me/profile", { name: "甲方新昵称" }, a);
    await page.locator(".document-actions").getByRole("button", { name: "历史版本", exact: true }).click();
    const entry = page.locator(`[data-version-id="${automatic.id}"]`);
    await expect(entry.locator(".history-editors")).toContainText("甲方新昵称");
    await expect(entry.locator(".history-editors")).toContainText("协作乙");
    await expect(entry.locator(".history-editors")).not.toContainText("仅阅读者");
    await entry.getByRole("button", { name: "查看版本", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "历史版本预览" });
    await expect(preview.locator(".history-editors")).toContainText("甲方新昵称");
    await preview.getByRole("button", { name: "关闭预览", exact: true }).click();
    await typeBody(page, "甲方的下一轮修改。");
    await expect.poll(async () => (await db.query("SELECT pending_editor_ids FROM documents WHERE id=$1", [note.id])).rows[0].pending_editor_ids).toEqual([a.user.id]);
    const saved = await api(request, "POST", `documents/${note.id}/versions`, { label: "管理员代为保留" }, root);
    const record = await api(request, "GET", `documents/${note.id}/versions/${saved.id}`, undefined, a);
    expect(record.author_id).toBe(root.user.id);
    expect(record.editors.map((e: any) => e.id)).toEqual([a.user.id]);
    const unchanged = await api(request, "POST", `documents/${note.id}/versions`, { label: "没有新修改" }, root);
    expect((await api(request, "GET", `documents/${note.id}/versions/${unchanged.id}`, undefined, a)).editors).toEqual([]);
    await api(request, "POST", `documents/${note.id}/versions`, {}, reader, 403);
  } finally { await context.close(); await readContext.close(); await db.end(); }
});

test("暗黑历史列表和预览文字对比达标，旧记录保留未知编辑者提示", async ({ page, request }) => {
  const root = await admin(request), owner = await person(request, root, "历史测试昵称"), db = pool();
  const book = await api(request, "POST", "spaces", { kind: "personal", name: "历史外观" }, owner);
  const note = await api(request, "POST", "documents", { space_id: book.id, title: "暗黑版本" }, owner);
  try {
    await api(request, "PATCH", "me/preferences", { theme: "dark" }, owner);
    await login(page, owner); await page.goto("/?doc=" + note.id);
    await typeBody(page, "版本内的研究内容。");
    await page.locator(".document-actions").getByRole("button", { name: "评论", exact: true }).click();
    const comments = page.getByRole("complementary", { name: "正文评论", exact: true });
    await expect(comments).toBeVisible();
    expect(await comments.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(248, 249, 252)");
    await contrast(comments.locator(".annotation-header > strong,.annotation-empty,.annotation-filter small"));
    await page.getByTestId("editor").locator("p").first().click();
    await page.getByRole("button", { name: "批注当前选区或段落", exact: true }).click();
    await page.getByLabel("评论内容", { exact: true }).fill("暗黑评论内容");
    await page.getByRole("button", { name: "添加评论", exact: true }).click();
    await expect(comments.locator(".annotation-message")).toHaveText("暗黑评论内容");
    await contrast(comments.locator(".annotation-message,.annotation-card header b,.annotation-card time"));
    const reply = comments.locator('input[aria-label^="回复 "]');
    await reply.fill("暗黑回复内容");
    await comments.getByRole("button", { name: "回复", exact: true }).click();
    await expect(comments.locator(".annotation-reply p")).toHaveText("暗黑回复内容");
    await contrast(comments.locator(".annotation-reply b,.annotation-reply p"));
    await chooseTheme(page, "light");
    await chooseTheme(page, "dark");
    expect(await comments.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(248, 249, 252)");
    await page.screenshot({ path: "artifacts/web/dark-comments-follow-theme.png" });
    await page.locator(".document-actions").getByRole("button", { name: "历史版本", exact: true }).click();
    const history = page.getByRole("complementary", { name: "历史版本", exact: true }), header = history.locator(".note-panel-header");
    for (const theme of ["dark", "light", "dark"] as const) {
      await chooseTheme(page, theme);
      await expect(page.locator("html")).not.toHaveClass(/theme-changing/);
      await expect(header.locator("strong")).toHaveText("历史版本");
      await expect(header).toHaveCSS("height", "48px");
      await expect(header.getByRole("button", { name: "收起侧栏", exact: true })).toHaveCSS("width", "32px");
      await expect(page.locator(".inspector-tabs")).toHaveCount(0);
      await contrast(header.locator("strong,button"));
      await page.screenshot({ path: `artifacts/web/note-panel-history-${theme}.png`, animations: "disabled" });
    }
    await page.locator(".document-actions").getByRole("button", { name: "评论", exact: true }).click(); await expect(comments).toBeVisible();
    await contrast(comments.locator(".note-panel-header strong,.note-panel-close"));
    await page.locator(".document-actions").getByRole("button", { name: "历史版本", exact: true }).click();
    await expect(header.locator("strong")).toHaveText("历史版本");
    await page.getByRole("tab",{name:"命名版本",exact:true}).click();await page.getByLabel("版本号",{exact:true}).fill("v1.0");await page.getByLabel("版本说明", { exact: true }).fill("可读的版本说明");
    await page.getByRole("button", { name: "保存当前版本", exact: true }).click();
    const row = page.locator(".history-entry").filter({ hasText: "可读的版本说明" });
    await expect(row.locator(".history-editors")).toContainText("历史测试昵称");
    await contrast(page.locator(".history-panel h3,.history-explanation,.history-entry b,.history-entry small,.history-editors"));
    await page.screenshot({ path: "artifacts/web/dark-history-editors.png" });
    await row.getByRole("button", { name: "查看版本", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "历史版本预览" });
    await contrast(preview.locator("h3,small,.history-editors,.snapshot-actions span"));
    const background = await preview.locator(".snapshot-modal").evaluate(el => getComputedStyle(el).backgroundColor);
    expect(background).not.toBe("rgb(255, 255, 255)");
    await page.screenshot({ path: "artifacts/web/dark-history-preview.png" });
    await preview.getByRole("button", { name: "关闭预览", exact: true }).click();
    await db.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source,created_at) SELECT $1,id,snapshot,ystate,'legacy-fixture','collaboration',now()-interval '1 day' FROM documents WHERE id=$2", [randomUUID(),note.id]);
    await page.reload();
    await page.locator(".document-actions").getByRole("button", { name: "历史版本", exact: true }).click();
    await expect(page.locator(".history-entry").filter({ hasText: "编辑者未记录" })).toHaveCount(1);
  } finally { await db.end(); }
});

test("1920×1080 设置紧凑完整显示、关闭按钮固定、Esc 退出，侧栏双行账户区保留笔记位置", async ({ page, request }) => {
  await page.setViewportSize({ width:1920, height:1080 });
  const root = await admin(request);
  await api(request, "PATCH", "me/preferences", { theme: "light" }, root);
  const manifest = JSON.parse(await fs.readFile("artifacts/releases/manifest.json", "utf8"));
  await page.route("**/api/client-releases", route => route.fulfill({ json:{...manifest,packages:manifest.packages.map((p: any) => ({...p,url:"/api/client-releases/"+p.file}))} }));
  await login(page);
  const toggle = page.getByRole("button", { name:"外观模式", exact:true });
  await expect(toggle).toHaveText("Light");
  const sidebar = page.locator(".academic-user");
  const order = await sidebar.locator(".sidebar-user-actions").evaluate(el => [...el.querySelectorAll(":scope > button")].map(e => e.getAttribute("aria-label")));
  expect(order).toEqual(["外观模式","设置","退出登录"]);
  const profile = (await sidebar.locator(".sidebar-user-profile").boundingBox())!;
  const actions = await sidebar.locator(".sidebar-user-actions > button").all();
  const bounds = await Promise.all(actions.map(async button => (await button.boundingBox())!));
  for (const boundsItem of bounds) {
    expect(boundsItem.height).toBe(40);
    expect(boundsItem.y - profile.y - profile.height).toBeGreaterThanOrEqual(10);
  }
  expect(bounds[1].x - bounds[0].x - bounds[0].width).toBeGreaterThanOrEqual(8);
  expect(bounds[2].x - bounds[1].x - bounds[1].width).toBeGreaterThanOrEqual(12);
  await page.locator(".academic-user").getByRole("button", { name:"设置",exact:true }).click();
  const settings = page.getByRole("dialog", { name:"设置",exact:true });
  await settings.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
  const initialBounds = (await settings.boundingBox())!;
  const stableBounds = async () => {
    const bounds = (await settings.boundingBox())!;
    for (const key of ["x","y","width","height"] as const) expect(bounds[key]).toBeCloseTo(initialBounds[key],0);
  };
  const fit = async () => expect(await settings.locator(".settings-body").evaluate(el => el.scrollHeight <= el.clientHeight+1)).toBe(true);
  await fit();
  await expect(settings.getByRole("button",{name:"外观模式",exact:true})).toHaveCount(0);
  await page.screenshot({ path:"artifacts/web/compact-account-1080.png" });
  await settings.getByRole("button",{name:"桌面客户端",exact:true}).click();
  await stableBounds();
  await fit();
  await expect(settings.getByRole("link",{name:/下载 ANote-/})).toHaveCount(4);
  await page.screenshot({ path:"artifacts/web/compact-clients-1080.png" });
  await settings.getByRole("button",{name:"平台管理",exact:true}).click();
  await stableBounds();
  const close = settings.locator(":scope > header").getByRole("button",{name:"关闭",exact:true}), before=(await close.boundingBox())!;
  await settings.locator(".settings-body").evaluate(el => el.scrollTop=el.scrollHeight);
  expect((await close.boundingBox())!.y).toBe(before.y);
  await expect(close).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  const url=page.url();
  await chooseTheme(page,"dark");
  await expect(toggle).toHaveText("Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme","dark");
  expect(page.url()).toBe(url);
  await expect.poll(async () => (await api(request,"GET","me",undefined,root)).theme).toBe("dark");
  await page.reload();
  await expect(toggle).toHaveText("Dark");
  await chooseTheme(page,"light");
});

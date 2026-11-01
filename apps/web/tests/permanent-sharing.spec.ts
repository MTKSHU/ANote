import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { api, login } from "./helpers";
import { person } from "./mcp-helpers";
async function setup(page: Page, request: APIRequestContext) {
  const owner = await person(request), book = await api(request, "POST", "spaces", { kind: "personal", name: "永久链接验证" }, owner),
    note = await api(request, "POST", "documents", { space_id: book.id, title: "长期只读资料" }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id); await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
  await page.getByLabel("上传附件文件", { exact: true }).setInputFiles("artifacts/server/fixtures/sample.png");
  await expect(page.locator(".media-resource img")).toHaveJSProperty("naturalWidth", 64);
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  return { owner, note };
}
test("永久外链可在分享弹窗生成、显示、匿名阅读附件、计数并撤销；定时链接仍会到期", async ({ page, request, browser }) => {
  const { owner, note } = await setup(page, request);
  await page.getByRole("button", { name: "共享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分享笔记", exact: true }); await expect(dialog.getByLabel("外链有效期", { exact: true })).toHaveValue("7");
  await dialog.getByLabel("外链有效期", { exact: true }).selectOption("permanent");
  await dialog.getByRole("button", { name: "生成外链", exact: true }).click();
  const url = await dialog.getByLabel("外部链接", { exact: true }).inputValue(); await expect(dialog.locator(".collaborator small")).toHaveText("永久有效");
  const sharing = await api(request, "GET", `documents/${note.id}/sharing`, undefined, owner), link = sharing.links[0];
  expect(link.expires_at).toBeNull(); expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).external_link_count).toBe(1);
  const timed = await api(request, "POST", `documents/${note.id}/sharing/links`, {}, owner);
  expect(new Date(timed.expires_at).getTime() - Date.now()).toBeGreaterThan(6 * 86400000);
  for (const days of [0, -1, "30", false, 365]) await api(request, "POST", `documents/${note.id}/sharing/links`, { days }, owner, 400);
  const context = await browser.newContext();
  try {
    const guest = await context.newPage(); await guest.goto(url); await expect(guest.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    await expect(guest.locator(".media-resource img")).toHaveJSProperty("naturalWidth", 64); await expect(guest.locator(".document-actions")).toHaveCount(0);
    // Only mutate this freshly created fixture link, on the isolated test network.
    expect(process.env.BASE_URL).toBe("http://anote.internal:3000");
    const client = new pg.Client({ host: "db", user: "anote", database: "anote", password: process.env.DB_PASSWORD });
    await client.connect();
    try { await client.query("UPDATE document_share_links SET expires_at=now()-interval '1 second' WHERE id=$1 AND doc_id=$2", [timed.id, note.id]); } finally { await client.end(); }
    const timedToken = timed.path.split("/").pop(); expect((await request.get("/api/public/notes/" + timedToken)).status()).toBe(404);
    expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).external_link_count).toBe(1);
    await dialog.locator(".collaborator").filter({ hasText: "永久有效" }).getByRole("button", { name: "撤销", exact: true }).click();
    await expect(dialog.locator(".collaborator small").filter({ hasText: "永久有效" })).toHaveCount(0);
    await expect(guest.getByTestId("editor")).toHaveCount(0, { timeout: 12000 }); await expect(guest.getByRole("status")).toContainText("分享已失效");
  } finally { await context.close(); }
});
test("团队关闭外部分享会撤销永久链接，重新开启也不会复活；禁止关闭期间生成", async ({ request }) => {
  const owner = await person(request), team = await api(request, "POST", "teams", { name: "长期资料团队" }, owner),
    book = await api(request, "POST", "spaces", { kind: "team", team_id: team.id, name: "团队资料" }, owner),
    note = await api(request, "POST", "documents", { space_id: book.id, title: "团队长期笔记" }, owner);
  await api(request, "PATCH", `teams/${team.id}`, { allow_external_sharing: true }, owner);
  const link = await api(request, "POST", `documents/${note.id}/sharing/links`, { days: null }, owner), path = "/api/public/notes/" + link.path.split("/").pop();
  expect((await request.get(path)).ok()).toBe(true);
  await api(request, "PATCH", `teams/${team.id}`, { allow_external_sharing: false }, owner); expect((await request.get(path)).status()).toBe(404);
  await api(request, "POST", `documents/${note.id}/sharing/links`, { days: null }, owner, 403);
  await api(request, "PATCH", `teams/${team.id}`, { allow_external_sharing: true }, owner); expect((await request.get(path)).status()).toBe(404);
});
test("只读成员不能创建永久外链，恢复仅自己可见会撤销永久外链", async ({ page, request }) => {
  const { owner, note } = await setup(page, request), viewer = await person(request), state = await api(request, "GET", `documents/${note.id}/sharing`, undefined, owner);
  await api(request, "PATCH", `documents/${note.id}/sharing`, { visibility: "private", access_revision: state.access_revision, collaborators: [{ user_id: viewer.user.id, role: "viewer" }] }, owner);
  await api(request, "POST", `documents/${note.id}/sharing/links`, { days: null }, viewer, 403);
  const link = await api(request, "POST", `documents/${note.id}/sharing/links`, { days: null }, owner);
  const latest = await api(request, "GET", `documents/${note.id}/sharing`, undefined, owner);
  await api(request, "PATCH", `documents/${note.id}/sharing`, { ...latest, only_me: true, visibility: "private", collaborators: [] }, owner);
  expect((await request.get("/api/public/notes/" + link.path.split("/").pop())).status()).toBe(404);
});

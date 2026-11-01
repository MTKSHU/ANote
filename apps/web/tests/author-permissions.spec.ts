import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { api, admin, login, typeBody } from "./helpers";

async function setup(request: APIRequestContext) {
  const root = await admin(request), password = "Author-permission-test-123!";
  async function person() {
    const username = "author-" + randomUUID().slice(0, 8);
    await api(request, "POST", "users", { username, password, name: username }, root);
    return { ...await api(request, "POST", "auth/login", { username, password }), username, password };
  }
  const manager = await person(), librarian = await person(), author = await person(), peer = await person(), editor = await person();
  const team = await api(request, "POST", "teams", { name: "作者权限团队" }, manager);
  for (const account of [librarian, author, peer, editor]) {
    const invite = await api(request, "POST", `teams/${team.id}/invites`, {}, manager);
    await api(request, "POST", `team-invitations/${new URL(invite.path, "http://test").searchParams.get("invite")}/accept`, {}, account);
  }
  const library = await api(request, "POST", "spaces", { name: "团队资料库", kind: "team", team_id: team.id }, librarian);
  const folder = await api(request, "POST", `spaces/${library.id}/folders`, { name: "实验目录" }, librarian);
  const note = await api(request, "POST", "documents", { space_id: library.id, title: "作者的研究笔记" }, author);
  async function share(people: any[]) {
    const current = await api(request, "GET", `documents/${note.id}/sharing`, undefined, author);
    return api(request, "PATCH", `documents/${note.id}/sharing`, { visibility: "team", access_revision: current.access_revision, collaborators: people }, author);
  }
  return { root, manager, librarian, author, peer, editor, team, library, folder, note, share };
}

test("团队默认仅评论与贡献，作者管理笔记，知识库管理、删除及明确授权分别校验", async ({ request }) => {
  const { root, manager, librarian, author, peer, editor, library, folder, note, share } = await setup(request);
  expect((await api(request, "GET", "spaces", undefined, peer)).find((s: any) => s.id === library.id).role).toBe("contributor");
  expect((await api(request, "GET", `documents/${note.id}`, undefined, peer)).role).toBe("reviewer");
  expect((await api(request, "GET", `documents/${note.id}`, undefined, author)).role).toBe("admin");
  for (const data of [{ title: "越权改名" }, { folder_id: folder.id }, { archived: true }])
    await api(request, "PATCH", `documents/${note.id}`, data, peer, 403);
  await api(request, "POST", `documents/${note.id}/import`, { markdown: "篡改", opId: randomUUID() }, peer, 403);
  await api(request, "POST", `documents/${note.id}/versions/not-a-version/restore`, { expectedHash: "invalid" }, peer, 403);
  await api(request, "POST", "uploads", { space_id: library.id, doc_id: note.id }, peer, 403);
  await api(request, "PATCH", `documents/${note.id}/sharing`, {}, peer, 403);
  await api(request, "DELETE", `documents/${note.id}`, undefined, peer, 403);
  await api(request, "PATCH", `spaces/${library.id}`, { name: "越权改库" }, peer, 403);
  await api(request, "POST", `spaces/${library.id}/folders`, { name: "越权新目录" }, peer, 403);
  await api(request, "PATCH", `spaces/${library.id}/folders/${folder.id}`, { name: "越权改目录" }, peer, 403);
  await api(request, "DELETE", `spaces/${library.id}`, undefined, peer, 403);
  const own = await api(request, "POST", "documents", { space_id: library.id, title: "成员自己的贡献", folder_id: folder.id }, peer);
  await api(request, "PATCH", `documents/${own.id}`, { title: "自己可以编辑" }, peer);
  await api(request, "PATCH", `documents/${note.id}`, { folder_id: folder.id, title: "作者可以编辑和归类" }, author);
  const privateNote = await api(request, "POST", "documents", { space_id: library.id, title: "作者未公开", visibility: "private" }, author);
  await api(request, "GET", `documents/${privateNote.id}`, undefined, peer, 403);
  await api(request, "POST", `spaces/${library.id}/members`, { user_id: editor.user.id, role: "editor" }, librarian);
  expect((await api(request, "GET", `documents/${note.id}`, undefined, editor)).role).toBe("editor");
  await api(request, "PATCH", `documents/${note.id}`, { title: "明确授权的全库编辑" }, editor);
  await api(request, "GET", `documents/${privateNote.id}`, undefined, editor, 403);
  await api(request, "POST", `spaces/${library.id}/folders`, { name: "编辑不能调整库结构" }, editor, 403);
  await api(request, "PATCH", `spaces/${library.id}/folders/${folder.id}`, { name: "不能改目录" }, editor, 403);
  await api(request, "DELETE", `spaces/${library.id}`, undefined, editor, 403);
  await api(request, "DELETE", `documents/${note.id}`, undefined, editor, 403);
  await api(request, "PATCH", `documents/${note.id}`, { archived: true }, editor, 403);
  await share([{ user_id: peer.user.id, role: "editor" }]);
  await api(request, "PATCH", `documents/${note.id}`, { title: "明确授权的笔记编辑" }, peer);
  await api(request, "PATCH", `documents/${note.id}`, { folder_id: null }, peer, 403);
  await api(request, "DELETE", `documents/${note.id}`, undefined, peer, 403);
  await share([]);
  await api(request, "PATCH", `documents/${note.id}`, { title: "撤销后不得编辑" }, peer, 403);
  for (const account of [manager, librarian])
    expect((await api(request, "GET", `documents/${note.id}`, undefined, account)).role).toBe("admin");
  await api(request, "GET", `documents/${note.id}`, undefined, root, 403);
  await api(request, "DELETE", `documents/${note.id}`, undefined, author);
  const deleted = (await api(request, "GET", "trash/documents", undefined, author)).find((item: any) => item.id === note.id);
  await api(request, "POST", `documents/${note.id}/restore-deleted`, {}, peer, 403);
  await api(request, "DELETE", `trash/documents/${note.id}`, { deletion_token: deleted.trash_batch }, peer, 403);
  await api(request, "POST", `documents/${note.id}/restore-deleted`, {}, author);
  await api(request, "DELETE", `spaces/${library.id}`, undefined, librarian);
  await api(request, "POST", `spaces/${library.id}/restore-deleted`, {}, peer, 403);
  await api(request, "POST", `spaces/${library.id}/restore-deleted`, {}, manager);
});

test("团队成员界面只读他人笔记并可评论、创建自己笔记，授权与撤销实时更新", async ({ page, request, browser }) => {
  const { author, peer, library, note, share } = await setup(request);
  await login(page, author);
  await page.goto("/?doc=" + note.id);
  await typeBody(page, "可供团队阅读的研究内容。");
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await login(other, peer);
    await other.goto("/?space=" + library.id);
    await expect(other.getByRole("button", { name: "新建目录", exact: true })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "新建笔记", exact: true }).first()).toBeEnabled();
    await other.locator(".note-open").filter({ hasText: note.title }).click();
    await expect(other.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    await expect(other.getByLabel("笔记标题", { exact: true })).toHaveJSProperty("readOnly", true);
    await other.locator(".document-actions").getByRole("button", { name: "评论", exact: true }).click();
    await other.getByTestId("editor").locator("p").first().click();
    await other.getByRole("button", { name: "批注当前选区或段落", exact: true }).click();
    await other.getByLabel("评论内容", { exact: true }).fill("团队默认权限可以讨论");
    await other.getByRole("button", { name: "添加评论", exact: true }).click();
    await expect(other.locator(".annotation-content")).toContainText("团队默认权限可以讨论");
    await share([{ user_id: peer.user.id, role: "editor" }]);
    await expect(other.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
    await typeBody(other, "明确授权后补充。");
    await expect(page.getByTestId("editor")).toContainText("明确授权后补充");
    await share([]);
    await expect(other.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    await other.getByRole("button", { name: "返回知识库", exact: true }).click();
    await other.getByRole("button", { name: "新建笔记", exact: true }).first().click();
    await expect(other.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
    await typeBody(other, "成员拥有自己创建的笔记。");
    await other.getByLabel("上传附件文件", { exact: true }).setInputFiles("artifacts/server/fixtures/sample.png");
    await expect(other.locator(".media-resource img")).toHaveJSProperty("naturalWidth", 64);
    await other.screenshot({ path: "artifacts/web/team-author-permissions.png" });
  } finally { await context.close(); }
});

test("绕过编辑界面的只读协作连接不能写入服务器正文", async ({ request, page }) => {
  const { author, peer, note } = await setup(request);
  const doc = new Y.Doc();
  let synced = false;
  const provider = new HocuspocusProvider({
    url: (process.env.BASE_URL || "http://anote.internal:3000").replace(/^http/, "ws") + "/collab",
    name: note.id, document: doc, token: JSON.stringify({ schema: EDITOR_SCHEMA_VERSION, token: peer.token }),
    onSynced: () => { synced = true; },
  });
  try {
    await expect.poll(() => synced).toBe(true);
    const before = await api(request, "GET", `documents/${note.id}`, undefined, author);
    const paragraph = doc.getXmlFragment("default").get(0) as Y.XmlElement;
    paragraph.insert(0, [new Y.XmlText("未授权协作写入")]);
    // Read-only updates have no acknowledgement; allow the socket and persistence
    // debounce to complete before checking authoritative state through another session.
    await page.waitForTimeout(1800);
    const after = await api(request, "GET", `documents/${note.id}`, undefined, author);
    expect(after.hash).toBe(before.hash);
    expect(JSON.stringify(after.snapshot)).not.toContain("未授权协作写入");
  } finally { provider.destroy(); doc.destroy(); }
});

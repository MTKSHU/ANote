import { test, expect } from "@playwright/test";
import { api, login } from "./helpers";
import { person } from "./mcp-helpers";
test("个人分享不显示团队权限或查询成员，候选接口也不能枚举陌生用户；外链继续可用", async ({ page, request }) => {
  const owner = await person(request), stranger = await person(request), book = await api(request, "POST", "spaces", { kind: "personal", name: "私有资源" }, owner), note = await api(request, "POST", "documents", { space_id: book.id, title: "个人隐私笔记" }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id); await expect(page.getByTestId("editor")).toBeVisible(); const memberRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("share-candidates")) memberRequests.push(request.url()); });
  await page.getByRole("button", { name: "共享", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "分享笔记", exact: true });
  await expect(dialog.getByLabel("外链有效期", { exact: true })).toBeVisible(); await expect(dialog.getByLabel("可见范围", { exact: true })).toHaveCount(0); await expect(dialog.getByLabel("邀请成员", { exact: true })).toHaveCount(0); await expect(dialog.getByRole("heading", { name: "指定成员", exact: true })).toHaveCount(0); await expect(dialog.getByRole("button", { name: "保存权限", exact: true })).toHaveCount(0);
  expect(memberRequests).toEqual([]); const candidates = await api(request, "GET", `documents/${note.id}/share-candidates`, undefined, owner); expect(candidates).toEqual([]); expect(JSON.stringify(candidates)).not.toContain(stranger.user.id);
  await dialog.getByLabel("外链有效期", { exact: true }).selectOption("permanent"); await dialog.getByRole("button", { name: "生成外链", exact: true }).click(); await expect(dialog.locator(".collaborator small")).toHaveText("永久有效");
});
test("个人旧协作授权保留且可主动关闭，团队候选成员仅限本团队与有权访问知识库的人", async ({ page, request }) => {
  const owner = await person(request), peer = await person(request), outsider = await person(request), book = await api(request, "POST", "spaces", { kind: "personal", name: "已有协作授权" }, owner), note = await api(request, "POST", "documents", { space_id: book.id, title: "已有授权的笔记" }, owner), old = await api(request, "GET", `documents/${note.id}/sharing`, undefined, owner);
  await api(request, "PATCH", `documents/${note.id}/sharing`, { visibility: "private", access_revision: old.access_revision, collaborators: [{ user_id: peer.user.id, role: "viewer" }] }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id); await expect(page.getByTestId("editor")).toBeVisible(); await page.getByRole("button", { name: "共享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分享笔记", exact: true }); await expect(dialog).toContainText("已有 1 项协作授权"); await expect(dialog.getByLabel("邀请成员", { exact: true })).toHaveCount(0); expect((await api(request, "GET", `documents/${note.id}`, undefined, peer)).role).toBe("viewer");
  await dialog.getByRole("button", { name: "恢复仅自己可见", exact: true }).click(); await expect(dialog).not.toContainText("已有 1 项协作授权"); await api(request, "GET", `documents/${note.id}`, undefined, peer, 403);
  const team = await api(request, "POST", "teams", { name: "成员隐私团队" }, owner), invitation = await api(request, "POST", `teams/${team.id}/invites`, {}, owner), token = new URL(invitation.path, "http://test").searchParams.get("invite"); await api(request, "POST", `team-invitations/${token}/accept`, {}, peer);
  const teamBook = await api(request, "POST", "spaces", { kind: "team", team_id: team.id, name: "团队协作库" }, owner), teamNote = await api(request, "POST", "documents", { space_id: teamBook.id, title: "团队笔记" }, owner), members = await api(request, "GET", `documents/${teamNote.id}/share-candidates`, undefined, owner);
  expect(members.map((member: any) => member.id)).toContain(peer.user.id); expect(members.map((member: any) => member.id)).not.toContain(outsider.user.id);
  await page.goto("/?doc=" + teamNote.id); await expect(page.getByTestId("editor")).toBeVisible(); await page.getByRole("button", { name: "共享", exact: true }).click(); await expect(page.getByRole("dialog", { name: "分享笔记", exact: true }).getByLabel("邀请成员", { exact: true })).toBeVisible();
});

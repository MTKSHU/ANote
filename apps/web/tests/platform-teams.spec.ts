import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { api, admin, login } from "./helpers";
const password = "Team-platform-test-123!";
test("移出团队关闭实时连接，平台会话撤销与普通用户修改本地密码", async ({
  request,
  page,
}) => {
  const root = await admin(request),
    owner = await account(request, root),
    member = await account(request, root),
    team = await api(request, "POST", "teams", { name: "实时权限" }, owner);
  await join(request, owner, team.id, member);
  const library = await api(
      request,
      "POST",
      "spaces",
      { name: "团队实时笔记", kind: "team", team_id: team.id },
      member,
    ),
    note = await api(
      request,
      "POST",
      "documents",
      { space_id: library.id, title: "权限撤销" },
      member,
    ),
    personal = await api(
      request,
      "POST",
      "spaces",
      { name: "个人保留", kind: "personal" },
      member,
    ),
    privateNote = await api(
      request,
      "POST",
      "documents",
      { space_id: personal.id, title: "自己的记录" },
      member,
    );
  await page.addInitScript(() => {
    const Original = WebSocket;
    (globalThis as any).__closedSockets = 0;
    (globalThis as any).WebSocket = class extends Original {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("close", () => {
          (globalThis as any).__closedSockets++;
        });
      }
    };
  });
  await login(page, member);
  await page.goto(`/?space=${library.id}&doc=${note.id}`);
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  await api(
    request,
    "POST",
    `teams/${team.id}/members`,
    { user_id: member.id, role: null },
    owner,
  );
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__closedSockets))
    .toBeGreaterThan(0);
  await api(request, "GET", `documents/${note.id}`, undefined, member, 403);
  await api(request, "GET", `documents/${privateNote.id}`, undefined, member);
  await api(request, "POST", `users/${member.id}/revoke-sessions`, {}, root);
  await api(
    request,
    "GET",
    `documents/${privateNote.id}`,
    undefined,
    member,
    401,
  );
  const fresh = await api(request, "POST", "auth/login", {
    username: member.username,
    password,
  });
  await api(
    request,
    "PATCH",
    "me",
    { old_password: "incorrect", password: "Changed-password-test-123!" },
    fresh,
    403,
  );
  await api(
    request,
    "PATCH",
    "me",
    { old_password: password, password: "Changed-password-test-123!" },
    fresh,
  );
  await api(request, "GET", "auth/session", undefined, fresh, 401);
  await api(
    request,
    "POST",
    "auth/login",
    { username: member.username, password },
    undefined,
    401,
  );
  expect(
    (
      await api(request, "POST", "auth/login", {
        username: member.username,
        password: "Changed-password-test-123!",
      })
    ).user.id,
  ).toBe(member.id);
});
async function account(request: APIRequestContext, root: any, name = "成员") {
  const username = "team-" + randomUUID().slice(0, 8),
    created = await api(
      request,
      "POST",
      "users",
      { username, name, password },
      root,
    );
  return {
    ...(await api(request, "POST", "auth/login", { username, password })),
    username,
    password,
    id: created.id,
  };
}
async function join(
  request: APIRequestContext,
  owner: any,
  teamId: string,
  member: any,
  email?: string,
) {
  const invite = await api(
    request,
    "POST",
    `teams/${teamId}/invites`,
    { email },
    owner,
  );
  const token = new URL(invite.path, "http://test").searchParams.get("invite");
  await api(request, "POST", `team-invitations/${token}/accept`, {}, member);
  return token;
}
test("普通用户创建多个团队、个人隐私、团队管理员与受限知识库权限独立", async ({
  request,
}) => {
  const root = await admin(request),
    a = await account(request, root, "团队创建者"),
    b = await account(request, root),
    outsider = await account(request, root);
  const first = await api(
      request,
      "POST",
      "teams",
      { name: "重建研究 " + randomUUID().slice(0, 6) },
      a,
    ),
    other = await api(request, "POST", "teams", { name: "另一团队" }, a);
  expect(first.role).toBe("admin");
  expect(
    (await api(request, "GET", "teams", undefined, a)).map((t: any) => t.id),
  ).toEqual(expect.arrayContaining([first.id, other.id]));
  const personal = await api(
      request,
      "POST",
      "spaces",
      { name: "自己的笔记", kind: "personal" },
      a,
    ),
    privateNote = await api(
      request,
      "POST",
      "documents",
      { space_id: personal.id, title: "私人内容" },
      a,
    );
  await join(request, a, first.id, b);
  await api(request, "GET", `documents/${privateNote.id}`, undefined, b, 403);
  await api(
    request,
    "GET",
    `documents/${privateNote.id}`,
    undefined,
    root,
    403,
  );
  const shared = await api(
      request,
      "POST",
      "spaces",
      { name: "默认团队知识库", kind: "team", team_id: first.id },
      b,
    ),
    restricted = await api(
      request,
      "POST",
      "spaces",
      {
        name: "受限知识库",
        kind: "team",
        team_id: first.id,
        access_mode: "restricted",
      },
      a,
    );
  const note = await api(
    request,
    "POST",
    "documents",
    { space_id: shared.id, title: "团队内容" },
    b,
  );
  expect(note.visibility).toBe("team");
  expect(
    (
      await api(
        request,
        "GET",
        `documents/${note.id}/share-candidates`,
        undefined,
        b,
      )
    ).some((candidate: any) => candidate.id === a.id),
  ).toBe(true);
  expect(
    (await api(request, "GET", `documents/${note.id}`, undefined, a)).role,
  ).toBe("admin");
  await api(
    request,
    "GET",
    `spaces/${restricted.id}/folders`,
    undefined,
    b,
    403,
  );
  await api(request, "GET", `documents/${note.id}`, undefined, outsider, 403);
  await api(request, "GET", `documents/${note.id}`, undefined, root, 403);
  await api(
    request,
    "POST",
    `spaces/${restricted.id}/members`,
    { user_id: b.id, role: "viewer" },
    a,
  );
  const restrictedNote = await api(
    request,
    "POST",
    "documents",
    { space_id: restricted.id, title: "阅读者不能管理共享" },
    a,
  );
  expect(
    (
      await api(
        request,
        "GET",
        `documents/${restrictedNote.id}/sharing`,
        undefined,
        b,
      )
    ).can_manage,
  ).toBe(false);
  await api(
    request,
    "POST",
    "documents",
    { space_id: restricted.id, title: "不能创建", visibility: "private" },
    b,
    403,
  );
  await api(
    request,
    "POST",
    `teams/${first.id}/members`,
    { user_id: b.id, role: "admin" },
    a,
  );
  expect(
    await api(request, "GET", `spaces/${restricted.id}/folders`, undefined, b),
  ).toEqual([]);
  await api(
    request,
    "POST",
    `teams/${first.id}/members`,
    { user_id: a.id, role: null },
    a,
  );
  await api(request, "GET", `documents/${note.id}`, undefined, a, 403);
  await api(
    request,
    "POST",
    `teams/${first.id}/members`,
    { user_id: b.id, role: null },
    b,
    409,
  );
});
test("指定邮箱邀请一次性、撤销、过期和已验证邮箱限制", async ({ request }) => {
  const root = await admin(request),
    owner = await account(request, root),
    member = await account(request, root),
    team = await api(request, "POST", "teams", { name: "邀请测试" }, owner),
    mail = member.username + "@example.test";
  const invitation = await api(
      request,
      "POST",
      `teams/${team.id}/invites`,
      { email: mail },
      owner,
    ),
    token = new URL(invitation.path, "http://test").searchParams.get("invite");
  await api(
    request,
    "POST",
    `team-invitations/${token}/accept`,
    {},
    member,
    403,
  );
  await api(
    request,
    "PATCH",
    `team/members/${member.id}`,
    { email: mail, email_verified: true },
    root,
  );
  await api(request, "POST", `team-invitations/${token}/accept`, {}, member);
  await api(
    request,
    "POST",
    `team-invitations/${token}/accept`,
    {},
    member,
    404,
  );
  const canceled = await api(
    request,
    "POST",
    `teams/${team.id}/invites`,
    {},
    owner,
  );
  await api(
    request,
    "DELETE",
    `teams/${team.id}/invites/${canceled.id}`,
    undefined,
    owner,
  );
  await api(
    request,
    "GET",
    `team-invitations/${new URL(canceled.path, "http://test").searchParams.get("invite")}`,
    undefined,
    member,
    404,
  );
  const expired = await api(
    request,
    "POST",
    `teams/${team.id}/invites`,
    {},
    owner,
  );
  const db = new Pool({
    host: "db",
    user: "anote",
    database: "anote",
    password: process.env.DB_PASSWORD,
  });
  try {
    await db.query(
      "UPDATE team_invites SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.id],
    );
  } finally {
    await db.end();
  }
  await api(
    request,
    "POST",
    `team-invitations/${new URL(expired.path, "http://test").searchParams.get("invite")}/accept`,
    {},
    member,
    404,
  );
});
test("团队关闭外部共享使已有链接失效，建库开关与团队归档即时执行", async ({
  request,
}) => {
  const root = await admin(request),
    owner = await account(request, root),
    member = await account(request, root),
    team = await api(request, "POST", "teams", { name: "团队安全" }, owner);
  await join(request, owner, team.id, member);
  const library = await api(
      request,
      "POST",
      "spaces",
      { kind: "team", team_id: team.id, name: "团队库" },
      member,
    ),
    note = await api(
      request,
      "POST",
      "documents",
      { space_id: library.id, title: "对外资料" },
      member,
    );
  await api(
    request,
    "POST",
    `documents/${note.id}/sharing/links`,
    {},
    member,
    403,
  );
  await api(
    request,
    "PATCH",
    `teams/${team.id}`,
    { allow_external_sharing: true },
    owner,
  );
  const link = await api(
    request,
    "POST",
    `documents/${note.id}/sharing/links`,
    {},
    member,
  );
  const token = link.path.split("/").pop();
  await api(request, "GET", `public/notes/${token}`);
  await api(
    request,
    "PATCH",
    `teams/${team.id}`,
    { allow_external_sharing: false, members_can_create_libraries: false },
    owner,
  );
  await api(request, "GET", `public/notes/${token}`, undefined, undefined, 404);
  await api(
    request,
    "POST",
    "spaces",
    { kind: "team", team_id: team.id, name: "不允许" },
    member,
    403,
  );
  await api(request, "GET", `documents/${note.id}`, undefined, member);
  await api(request, "PATCH", `teams/${team.id}`, { archived: true }, owner);
  await api(request, "GET", `documents/${note.id}`, undefined, member, 403);
  await api(request, "PATCH", `teams/${team.id}`, { archived: false }, owner);
  await api(request, "GET", `documents/${note.id}`, undefined, member);
});
test("团队首页显示公告、置顶与最近笔记，普通用户可从界面创建团队", async ({
  page,
  request,
}) => {
  const root = await admin(request),
    owner = await account(request, root, "界面用户");
  await login(page, owner);
  await page.getByRole("button", { name: /^我的团队/ }).click();
  await page.getByRole("button", { name: "创建团队", exact: true }).click();
  await page.getByLabel("团队名称", { exact: true }).fill("影视研究小组");
  await page
    .locator("form")
    .getByRole("button", { name: "创建团队", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "影视研究小组", exact: true }),
  ).toBeVisible();
  const teamId = new URL(page.url()).searchParams.get("team")!;
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await page.getByRole("button", { name: "新建知识库", exact: true }).click();
  const dialog = page.getByRole("dialog", {name:"新建知识库",exact:true});
  await dialog.getByLabel("名称", { exact: true }).fill("入门教程");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".academic-page-header h1")).toHaveText("入门教程");
  const library = (await api(request, "GET", "spaces", undefined, owner)).find(
      (l: any) => l.name === "入门教程",
    ),
    note = await api(
      request,
      "POST",
      "documents",
      { space_id: library.id, title: "欢迎加入课题组" },
      owner,
    );
  await api(
    request,
    "PATCH",
    `teams/${teamId}`,
    { announcement_doc_id: note.id },
    owner,
  );
  await page.goto("/?team=" + teamId);
  await expect(page.locator(".team-pinned")).toContainText(
    "欢迎加入课题组",
  );
  await page.getByRole("button", {name:"知识库",exact:true}).click();
  await page.getByRole("button", {name:"管理知识库 入门教程",exact:true}).click();
  await page.getByLabel("团队置顶知识库").check();
  expect(await page.getByLabel("团队置顶知识库").evaluate(el=>{const a=el.getBoundingClientRect(),b=el.parentElement!.getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2);})).toBeLessThan(3);
  await page.getByRole("dialog",{name:"管理知识库"}).getByRole("button",{name:"保存",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"管理知识库"})).toHaveCount(0);
  await expect.poll(async()=>(await api(request,"GET","spaces",undefined,owner)).find((l:any)=>l.id===library.id).pinned).toBe(true);
  await page.getByRole("button", { name: "成员", exact: true }).click();
  await page
    .getByRole("button", { name: "生成邀请链接", exact: true })
    .click();
  await expect(page.getByLabel("团队邀请链接", { exact: true })).toHaveValue(
    /invite=/,
  );
  await page.screenshot({
    path: "artifacts/web/team-members.png",
    fullPage: true,
  });
  await page.locator(".team-hub .management-tabs").getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("允许团队笔记对外分享")).not.toBeChecked();
  await page.screenshot({
    path: "artifacts/web/team-settings.png",
    fullPage: true,
  });
});
test("平台设置只有平台管理员能修改，域名配置动态生效且保留旧源", async ({
  request,
  page,
}) => {
  const root = await admin(request),
    member = await account(request, root);
  await api(request, "GET", "admin/settings", undefined, member, 403);
  await api(
    request,
    "PATCH",
    "admin/settings",
    { site_name: "越权" },
    member,
    403,
  );
  const original = await api(request, "GET", "admin/settings", undefined, root);
  try {
    const saved = await api(
      request,
      "PATCH",
      "admin/settings",
      {
        revision: original.revision,
        site_name: "ANote",
        public_origin: "https://new-notes.example.test",
      },
      root,
    );
    expect(saved.allowed_origins).toContain(original.public_origin);
    const pub = await api(request, "GET", "platform/public");
    expect(pub.public_origin).toBe("https://new-notes.example.test");
    await api(
      request,
      "PATCH",
      "admin/settings",
      { revision: original.revision, site_name: "覆盖" },
      root,
      409,
    );
  } finally {
    const fresh = await api(request, "GET", "admin/settings", undefined, root);
    await api(
      request,
      "PATCH",
      "admin/settings",
      { ...original, revision: fresh.revision },
      root,
    );
  }
  await login(page);
  await page
    .locator(".academic-user")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page
    .getByRole("button", { name: "平台管理", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("公共访问地址", { exact: true })).toHaveValue(
    original.public_origin,
  );
  await expect(
    page.getByLabel("OIDC Client Secret", { exact: true }),
  ).toHaveValue("");
  await page.screenshot({
    path: "artifacts/web/platform-settings.png",
    fullPage: true,
  });
});

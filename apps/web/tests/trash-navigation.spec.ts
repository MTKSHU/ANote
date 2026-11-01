import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { api, admin, login } from "./helpers";
import MarkdownIt from "markdown-it";
const password = "Recycle-navigation-test-123!";
async function person(request: APIRequestContext, root: any) {
  const username = "trash-" + randomUUID().slice(0, 8);
  const row = await api(
    request,
    "POST",
    "users",
    { username, name: username, password },
    root,
  );
  return {
    ...(await api(request, "POST", "auth/login", { username, password })),
    username,
    password,
    id: row.id,
  };
}
async function join(
  request: APIRequestContext,
  owner: any,
  team: any,
  member: any,
) {
  const invite = await api(
    request,
    "POST",
    `teams/${team.id}/invites`,
    {},
    owner,
  );
  const token = new URL(invite.path, "http://test").searchParams.get("invite");
  await api(request, "POST", `team-invitations/${token}/accept`, {}, member);
  return token;
}
async function library(request: APIRequestContext, owner: any, team?: any) {
  return api(
    request,
    "POST",
    "spaces",
    {
      name: "资料库 " + randomUUID().slice(0, 5),
      kind: team ? "team" : "personal",
      team_id: team?.id,
    },
    owner,
  );
}
async function note(
  request: APIRequestContext,
  owner: any,
  space: any,
  title = "实验记录",
) {
  return api(
    request,
    "POST",
    "documents",
    { space_id: space.id, title },
    owner,
  );
}
async function body(
  page: Page,
  request: APIRequestContext,
  owner: any,
  id: string,
  markdown: string,
) {
  const context = await page
    .context()
    .browser()!
    .newContext({
      baseURL: process.env.BASE_URL || "http://anote.internal:3000",
    });
  try {
    const other = await context.newPage();
    await login(other, owner);
    await other.goto("/?doc=" + id);
    const editor = other.getByTestId("editor");
    await expect(editor).toBeVisible();
    const before = await api(
      request,
      "GET",
      `documents/${id}`,
      undefined,
      owner,
    );
    await editor.locator(":scope > p").last().click();
    await other.keyboard.press("End");
    await editor.evaluate((element, html) => {
      const data = new DataTransfer();
      data.setData("text/html", html);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, new MarkdownIt().render(markdown));
    await expect
      .poll(
        async () =>
          (await api(request, "GET", `documents/${id}`, undefined, owner)).hash,
      )
      .not.toBe(before.hash);
    // Wait for an explicit server acknowledgement before closing the peer.
    // The automatic indicator can still describe the preceding saved state.
    await other.keyboard.press("ControlOrMeta+s");
    await expect(other.getByTestId("document-sync")).toHaveText("已保存");
    return await api(request, "GET", `documents/${id}`, undefined, owner);
  } finally {
    await context.close();
  }
}

test("删除笔记撤销访问和实时连接，恢复保留正文、目录、评论与版本，外链保持撤销", async ({
  request,
  page,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    book = await library(request, owner);
  const folder = await api(
    request,
    "POST",
    `spaces/${book.id}/folders`,
    { name: "实验" },
    owner,
  );
  const n = await api(
    request,
    "POST",
    "documents",
    { space_id: book.id, folder_id: folder.id, title: "需要恢复的笔记" },
    owner,
  );
  const before = await body(
    page,
    request,
    owner,
    n.id,
    "## 保真标题\n\n实验结果 **加粗** 与表格。\n\n| 方法 | 指标 |\n| --- | --- |\n| A | 92 |",
  );
  const heading = before.snapshot.content.find(
    (node: any) => node.type === "heading",
  );
  const comment = await api(
    request,
    "POST",
    `documents/${n.id}/comments`,
    {
      text: "保留这条评论",
      anchor: { blockId: heading.attrs.blockId, quote: "保真标题" },
    },
    owner,
  );
  const versions = await api(
    request,
    "GET",
    `documents/${n.id}/versions`,
    undefined,
    owner,
  );
  const link = await api(
      request,
      "POST",
      `documents/${n.id}/sharing/links`,
      {},
      owner,
    ),
    token = link.path.split("/").pop();
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
  await login(page, owner);
  await page.goto("/?doc=" + n.id);
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  await api(request, "DELETE", `documents/${n.id}`, undefined, root, 403);
  await api(request, "DELETE", `documents/${n.id}`, undefined, owner);
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__closedSockets))
    .toBeGreaterThan(0);
  for (const suffix of [
    "",
    "/export",
    "/versions",
    "/comments",
    "/assets",
    "/sharing",
  ])
    await api(
      request,
      "GET",
      `documents/${n.id}${suffix}`,
      undefined,
      owner,
      404,
    );
  await api(request, "GET", `public/notes/${token}`, undefined, undefined, 404);
  expect(
    (await api(request, "GET", "documents", undefined, owner)).some(
      (v: any) => v.id === n.id,
    ),
  ).toBe(false);
  expect(
    (await api(request, "GET", "documents?q=保真", undefined, owner)).some(
      (v: any) => v.id === n.id,
    ),
  ).toBe(false);
  expect(
    (await api(request, "GET", "trash/documents", undefined, root)).some(
      (v: any) => v.id === n.id,
    ),
  ).toBe(false);
  await api(request, "POST", `documents/${n.id}/restore-deleted`, {}, owner);
  const restored = await api(
    request,
    "GET",
    `documents/${n.id}`,
    undefined,
    owner,
  );
  expect(restored.snapshot).toEqual(before.snapshot);
  expect(restored.folder_id).toBe(folder.id);
  expect(
    (
      await api(request, "GET", `documents/${n.id}/comments`, undefined, owner)
    )[0].id,
  ).toBe(comment.id);
  const afterVersions = await api(
    request,
    "GET",
    `documents/${n.id}/versions`,
    undefined,
    owner,
  );
  for (const version of versions)
    expect(afterVersions.some((v: any) => v.id === version.id)).toBe(true);
  await api(request, "GET", `public/notes/${token}`, undefined, undefined, 404);
});
test("团队、知识库按删除批次恢复；独立删除内容不会意外复活，权限与邀请持续生效", async ({
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    member = await person(request, root),
    team = await api(request, "POST", "teams", { name: "恢复层级" }, owner);
  await join(request, owner, team, member);
  const pending = await api(
      request,
      "POST",
      `teams/${team.id}/invites`,
      {},
      owner,
    ),
    inviteToken = new URL(pending.path, "http://test").searchParams.get(
      "invite",
    );
  const book = await library(request, owner, team),
    oldBook = await library(request, owner, team),
    a = await note(request, owner, book, "活跃笔记"),
    b = await note(request, owner, book, "单独删除"),
    c = await note(request, owner, oldBook, "旧库笔记");
  await api(request, "DELETE", `spaces/${book.id}`, undefined, member, 403);
  await api(request, "DELETE", `teams/${team.id}`, undefined, member, 403);
  await api(request, "DELETE", `documents/${a.id}`, undefined, member, 403);
  await api(request, "DELETE", `documents/${b.id}`, undefined, owner);
  await api(request, "DELETE", `spaces/${oldBook.id}`, undefined, owner);
  await api(request, "DELETE", `teams/${team.id}`, undefined, owner);
  expect(
    (await api(request, "GET", "teams", undefined, owner)).some(
      (v: any) => v.id === team.id,
    ),
  ).toBe(false);
  expect(
    (await api(request, "GET", "spaces", undefined, owner)).some(
      (v: any) => v.id === book.id,
    ),
  ).toBe(false);
  expect(
    (await api(request, "GET", "trash/spaces", undefined, owner)).some(
      (v: any) => v.id === oldBook.id,
    ),
  ).toBe(false);
  expect(
    (await api(request, "GET", "trash/documents", undefined, owner)).some(
      (v: any) => [a.id, b.id, c.id].includes(v.id),
    ),
  ).toBe(false);
  await api(
    request,
    "POST",
    `spaces/${oldBook.id}/restore-deleted`,
    {},
    owner,
    409,
  );
  await api(request, "GET", `documents/${a.id}`, undefined, member, 404);
  await api(
    request,
    "POST",
    `teams/${team.id}/restore-deleted`,
    {},
    member,
    403,
  );
  await api(request, "POST", `teams/${team.id}/restore-deleted`, {}, owner);
  await api(request, "GET", `documents/${a.id}`, undefined, member);
  await api(request, "GET", `documents/${b.id}`, undefined, owner, 404);
  await api(request, "GET", `documents/${c.id}`, undefined, owner, 404);
  expect(
    (await api(request, "GET", "trash/spaces", undefined, owner)).some(
      (v: any) => v.id === oldBook.id,
    ),
  ).toBe(true);
  await api(
    request,
    "GET",
    `team-invitations/${inviteToken}`,
    undefined,
    member,
    404,
  );
  await api(
    request,
    "POST",
    `team-invitations/${inviteToken}/accept`,
    {},
    member,
    404,
  );
  await api(request, "POST", `spaces/${oldBook.id}/restore-deleted`, {}, owner);
  await api(request, "GET", `documents/${c.id}`, undefined, owner);
  await api(request, "DELETE", `spaces/${book.id}`, undefined, owner);
  await api(request, "POST", `spaces/${book.id}/restore-deleted`, {}, owner);
  await api(request, "GET", `documents/${a.id}`, undefined, owner);
  await api(request, "GET", `documents/${b.id}`, undefined, owner, 404);
  await api(request, "POST", `documents/${b.id}/restore-deleted`, {}, owner);
  await api(request, "GET", `documents/${b.id}`, undefined, owner);
});
test("私人知识库删除不授予平台管理员或协作者管理权；恢复共享与公告设置不阻塞", async ({
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    reader = await person(request, root),
    book = await library(request, owner),
    n = await note(request, owner, book);
  const metadata = await api(
    request,
    "GET",
    `documents/${n.id}`,
    undefined,
    owner,
  );
  await api(
    request,
    "PATCH",
    `documents/${n.id}/sharing`,
    {
      visibility: "private",
      collaborators: [{ user_id: reader.id, role: "viewer" }],
      access_revision: Number(metadata.access_revision),
    },
    owner,
  );
  await api(request, "GET", `documents/${n.id}`, undefined, reader);
  await api(request, "DELETE", `spaces/${book.id}`, undefined, root, 403);
  await api(request, "DELETE", `spaces/${book.id}`, undefined, reader, 403);
  await api(request, "DELETE", `spaces/${book.id}`, undefined, owner);
  expect(
    (await api(request, "GET", "trash/spaces", undefined, root)).some(
      (v: any) => v.id === book.id,
    ),
  ).toBe(false);
  expect(
    (await api(request, "GET", "trash/spaces", undefined, reader)).some(
      (v: any) => v.id === book.id,
    ),
  ).toBe(false);
  await api(request, "GET", `documents/${n.id}`, undefined, reader, 404);
  await api(
    request,
    "POST",
    `spaces/${book.id}/restore-deleted`,
    {},
    root,
    403,
  );
  await api(request, "POST", `spaces/${book.id}/restore-deleted`, {}, owner);
  await api(request, "GET", `documents/${n.id}`, undefined, reader);
  const team = await api(
      request,
      "POST",
      "teams",
      { name: "公告删除恢复" },
      owner,
    ),
    teamBook = await library(request, owner, team),
    announcement = await note(request, owner, teamBook, "公告");
  await api(
    request,
    "PATCH",
    `teams/${team.id}`,
    { announcement_doc_id: announcement.id },
    owner,
  );
  await api(
    request,
    "DELETE",
    `documents/${announcement.id}`,
    undefined,
    owner,
  );
  await api(
    request,
    "PATCH",
    `teams/${team.id}`,
    {
      description: "公告暂时删除，仍可保存设置",
      announcement_doc_id: announcement.id,
    },
    owner,
  );
  await api(
    request,
    "POST",
    `documents/${announcement.id}/restore-deleted`,
    {},
    owner,
  );
  expect(
    (await api(request, "GET", `teams/${team.id}`, undefined, owner))
      .announcement_doc_id,
  ).toBe(announcement.id);
});
test("团队名称与固定知识库导航、编辑返回列表，文内目录随远程编辑刷新", async ({
  request,
  page,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    team = await api(request, "POST", "teams", { name: "影视研究组" }, owner),
    book = await library(request, owner, team);
  const one = await note(request, owner, book, "长文笔记"),
    two = await note(request, owner, book, "第二篇笔记");
  await body(
    page,
    request,
    owner,
    one.id,
    "# 总览\n\n" +
      Array.from({ length: 28 }, (_, i) => "段落 " + i + " 内容。").join(
        "\n\n",
      ) +
      "\n\n##### 远处结论",
  );
  await login(page, owner);
  await expect(
    page
      .locator(".academic-navigation")
      .getByRole("button", { name: "团队知识库", exact: true }),
  ).toHaveCount(0);
  const navigationLabels = await page
    .getByRole("navigation", { name: "主导航" })
    .locator("button > span")
    .allTextContents();
  await page
    .getByRole("button", { name: "影视研究组团队", exact: true })
    .click();
  await expect(page.locator(".team-pinned")).toBeVisible();
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "影视研究组知识库", exact: true }),
  ).toBeVisible();
  await page
    .locator(".library-card")
    .filter({ hasText: book.name })
    .getByRole("button", { name: "固定到侧栏 " + book.name, exact: true })
    .click();
  await page.locator(".library-open").filter({ hasText: book.name }).click();
  await page
    .locator(".note-table-row .note-open")
    .filter({ hasText: "长文笔记" })
    .click();
  const sidebar = page.getByRole("complementary", { name: "知识库侧边栏" });
  const pinned = sidebar
    .locator(".sidebar-library")
    .filter({ hasText: book.name });
  await expect(pinned).toBeVisible();
  await expect(
    sidebar.locator(".catalog-tree,.catalog-note,.folder-open"),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "全部笔记", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "返回知识库", exact: true }).click();
  await page
    .locator(".note-table-row .note-open")
    .filter({ hasText: "第二篇笔记" })
    .click();
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue(
    "第二篇笔记",
  );
  await page.getByRole("button", { name: "返回知识库", exact: true }).click();
  await page
    .locator(".note-table-row .note-open")
    .filter({ hasText: "长文笔记" })
    .click();
  await expect(page.getByTestId("editor")).toContainText("远处结论");
  await expect(
    page.getByRole("navigation", { name: "主导航" }).locator("button > span"),
  ).toHaveText(navigationLabels);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "首页", exact: true })
    .click();
  await expect(pinned).toBeVisible();
  await pinned.click();
  await page
    .locator(".note-table-row .note-open")
    .filter({ hasText: "长文笔记" })
    .click();
  await expect(page.getByTestId("editor")).toContainText("远处结论");
  let releaseInitial!: () => void, initialSeen!: () => void;
  const initialRequest = new Promise<void>((resolve) => {
    initialSeen = resolve;
  });
  const initialRelease = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  let first = true;
  await page.route("**/api/spaces", async (route) => {
    if (first) {
      first = false;
      initialSeen();
      await initialRelease;
    }
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await initialRequest;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("button", { name: "返回知识库", exact: true }),
    ).toBeEnabled();
    await expect(pinned).toBeVisible();
  } finally {
    releaseInitial();
    await page.unrouteAll({ behavior: "wait" });
  }
  expect(
    (await page.locator(".note-workspace").boundingBox())!.width / 1580,
  ).toBeGreaterThan(0.8);
  await page.getByRole("button", {name:"隐藏笔记列表",exact:true}).click();
  expect((await page.locator(".document-region").boundingBox())!.width / 1580).toBeGreaterThan(0.8);
  await page.getByRole("button", { name: "显示文内目录", exact: true }).click();
  const outline = page.getByRole("complementary", { name: "文内目录" });
  await expect(outline).toContainText("总览");
  const collapse = sidebar
    .locator(".academic-sidebar-heading")
    .getByRole("button", { name: "收起侧边栏", exact: true });
  await expect(collapse).toBeVisible();
  await expect(
    sidebar
      .locator(".academic-user")
      .getByRole("button", { name: "收起侧边栏", exact: true }),
  ).toHaveCount(0);
  const collapseBox = (await collapse.boundingBox())!;
  expect(collapseBox.y).toBeLessThan(80);
  const editor = page.getByTestId("editor"),
    beforeToggleURL = page.url();
  await editor.evaluate((el) => (el.dataset.toggleCheck = "retained"));
  await collapse.click();
  const expand = page.getByRole("button", { name: "展开侧边栏", exact: true });
  await expect(expand).toBeVisible();
  expect(
    Math.abs((await expand.boundingBox())!.y - collapseBox.y),
  ).toBeLessThan(1);
  await expect(outline).toBeVisible();
  await expect(editor).toHaveAttribute("data-toggle-check", "retained");
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(collapse).toBeVisible();
  await expect(editor).toHaveAttribute("data-toggle-check", "retained");
  expect(page.url()).toBe(beforeToggleURL);
  await page.setViewportSize({ width: 700, height: 1000 });
  await expect(collapse).toBeInViewport();
  await collapse.click();
  await expect(expand).toBeInViewport();
  await expand.click();
  await page.setViewportSize({ width: 1580, height: 1150 });
  await page.screenshot({ path: "artifacts/web/sidebar-heading-toggle.png" });
  await expect(outline.locator("nav button small")).toHaveCount(0);
  await outline.getByRole("button", { name: "远处结论",exact:true }).click();
  await expect(page.getByTestId("editor").locator("h5")).toBeInViewport();
  await body(page, request, owner, one.id, "## 协作更新标题");
  await expect(outline).toContainText("协作更新标题");
  await outline.getByRole("button", { name: "隐藏文内目录" }).click();
  await expect(outline).toHaveCount(0);
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.getByRole("button", { name: "显示文内目录" }).click();
  await expect(outline).toContainText("协作更新标题");
  await page.screenshot({
    path: "artifacts/web/academic-outline-navigation.png",
  });
  await page
    .locator(".document-header")
    .getByRole("button", { name: "返回知识库", exact: true })
    .click();
  await expect(page.locator(".note-table-row")).toHaveCount(2);
  const more = page.locator(".note-table-row .row-more").first();
  expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});
test("笔记、知识库、团队的删除入口、确认和回收站恢复贯通", async ({
  request,
  page,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    team = await api(request, "POST", "teams", { name: "待删除团队" }, owner),
    book = await library(request, owner, team),
    n = await note(request, owner, book, "可恢复笔记");
  await login(page, owner);
  await page.goto("/?doc=" + n.id);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByRole("button", { name: "笔记更多操作" }).click();
  await page.getByRole("button", { name: "删除笔记", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认删除" });
  await expect(dialog).toContainText("可恢复笔记");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByRole("button", { name: "笔记更多操作" }).click();
  await page.getByRole("button", { name: "删除笔记", exact: true }).click();
  await dialog.getByRole("button", { name: "移入回收站", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .locator(".academic-navigation")
    .getByRole("button", { name: /回收站/ })
    .click();
  await page
    .getByRole("button", { name: "恢复笔记 可恢复笔记", exact: true })
    .click();
  await expect(
    page.locator(".trash-group").filter({ hasText: "没有已删除的笔记" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "待删除团队", exact: true }).click();
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await page
    .getByRole("button", { name: "管理知识库 " + book.name, exact: true })
    .click();
  await page.getByRole("button", { name: "删除知识库", exact: true }).click();
  await dialog.getByRole("button", { name: "移入回收站" }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .locator(".academic-navigation")
    .getByRole("button", { name: /回收站/ })
    .click();
  await page
    .getByRole("tab", { name: /^知识库/ })
    .click();
  await page
    .getByRole("button", { name: "恢复知识库 " + book.name, exact: true })
    .click();
  await expect(
    page.locator(".trash-group").filter({ hasText: "没有已删除的知识库" }),
  ).toBeVisible();
  await page
    .locator(".academic-navigation")
    .getByRole("button", { name: /我的团队/ })
    .click();
  await page.locator(".team-card").filter({ hasText: "待删除团队" }).click();
  await page.locator(".team-hub .management-tabs").getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "删除团队", exact: true }).click();
  await dialog.getByRole("button", { name: "移入回收站" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "待删除团队", exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".academic-navigation")
    .getByRole("button", { name: /回收站/ })
    .click();
  await page.screenshot({ path: "artifacts/web/academic-trash.png" });
  await page.getByRole("tab", { name: /^团队/ }).click();
  await page
    .getByRole("button", { name: "恢复团队 待删除团队", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "待删除团队", exact: true }),
  ).toBeVisible();
});

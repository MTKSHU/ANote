import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { api, admin, login, typeBody, chooseTheme } from "./helpers";
const password = "Sidebar-appearance-test-123!";
test("首页个人与团队笔记按知识库归属分开，团队私有笔记不会混入个人，搜索保留分类", async ({
  page,
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    peer = await person(request, root);
  const team = await api(request, "POST", "teams", { name: "分类团队" }, owner);
  const invite = await api(
    request,
    "POST",
    `teams/${team.id}/invites`,
    {},
    owner,
  );
  await api(
    request,
    "POST",
    `team-invitations/${new URL(invite.path, "http://test").searchParams.get("invite")}/accept`,
    {},
    peer,
  );
  const personal = await book(request, owner, "个人资料"),
    shared = await book(request, owner, "团队资料", team),
    other = await book(request, peer, "他人的资料");
  const make = (
    account: any,
    library: any,
    title: string,
    visibility?: string,
  ) =>
    api(
      request,
      "POST",
      "documents",
      { space_id: library.id, title, visibility },
      account,
    );
  await make(owner, personal, "分类验证 个人记录");
  await make(owner, shared, "分类验证 自建团队记录");
  await make(owner, shared, "分类验证 团队私有记录", "private");
  await make(peer, shared, "分类验证 同事团队记录");
  const sharedNote = await make(peer, other, "分类验证 分享给我的记录");
  const metadata = await api(
    request,
    "GET",
    `documents/${sharedNote.id}`,
    undefined,
    peer,
  );
  await api(
    request,
    "PATCH",
    `documents/${sharedNote.id}/sharing`,
    {
      visibility: "private",
      collaborators: [{ user_id: owner.id, role: "viewer" }],
      access_revision: Number(metadata.access_revision),
    },
    peer,
  );
  await login(page, owner);
  const titles = () =>
    page.locator(".note-table-row .note-open strong").allTextContents();
  await expect(page.locator(".note-table-row")).toHaveCount(5);
  await page
    .locator(".home-tabs")
    .getByRole("button", { name: "个人", exact: true })
    .click();
  await expect.poll(titles).toEqual(["分类验证 个人记录"]);
  await page.getByLabel("搜索笔记", { exact: true }).fill("分类验证");
  await expect.poll(titles).toEqual(["分类验证 个人记录"]);
  await page
    .locator(".home-tabs")
    .getByRole("button", { name: "团队", exact: true })
    .click();
  await expect
    .poll(async () => (await titles()).sort())
    .toEqual(
      [
        "分类验证 同事团队记录",
        "分类验证 团队私有记录",
        "分类验证 自建团队记录",
      ].sort(),
    );
  await page
    .locator(".home-tabs")
    .getByRole("button", { name: "分享给我", exact: true })
    .click();
  await expect.poll(titles).toEqual(["分类验证 分享给我的记录"]);
  await page
    .locator(".home-tabs")
    .getByRole("button", { name: "最近", exact: true })
    .click();
  await expect(page.locator(".note-table-row")).toHaveCount(5);
});
async function person(
  request: APIRequestContext,
  root: any,
  administrator = false,
) {
  const username = "sidebar-" + randomUUID().slice(0, 8);
  const user = await api(
    request,
    "POST",
    "users",
    { username, name: username, password, is_admin: administrator },
    root,
  );
  return {
    ...(await api(request, "POST", "auth/login", { username, password })),
    username,
    password,
    id: user.id,
  };
}
async function book(
  request: APIRequestContext,
  owner: any,
  name: string,
  team?: any,
  restricted = false,
) {
  return api(
    request,
    "POST",
    "spaces",
    {
      name,
      kind: team ? "team" : "personal",
      team_id: team?.id,
      access_mode: restricted ? "restricted" : "team",
    },
    owner,
  );
}
test("侧栏固定按账号保存，阅读者可固定；不会改变团队置顶或绕过受限知识库权限", async ({
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    viewer = await person(request, root);
  const personal = await book(request, owner, "私有固定资料");
  const libraries = (account: any) =>
    api(request, "GET", "spaces", undefined, account);
  const pin = (account: any, id: string, value: any, status?: number) =>
    api(
      request,
      "PATCH",
      `spaces/${id}/sidebar-pin`,
      { pinned: value },
      account,
      status,
    );
  expect(
    (await libraries(owner)).find((b: any) => b.id === personal.id)
      .sidebar_pinned,
  ).toBe(false);
  await pin(root, personal.id, true, 403);
  await pin(viewer, personal.id, true, 403);
  await pin(owner, personal.id, "true", 400);
  await pin(owner, personal.id, true);
  await pin(owner, personal.id, true);
  const fresh = await api(request, "POST", "auth/login", {
    username: owner.username,
    password,
  });
  expect(
    (await libraries(fresh)).find((b: any) => b.id === personal.id)
      .sidebar_pinned,
  ).toBe(true);
  const team = await api(
    request,
    "POST",
    "teams",
    { name: "固定权限团队" },
    owner,
  );
  const invite = await api(
    request,
    "POST",
    `teams/${team.id}/invites`,
    {},
    owner,
  );
  await api(
    request,
    "POST",
    `team-invitations/${new URL(invite.path, "http://test").searchParams.get("invite")}/accept`,
    {},
    viewer,
  );
  const restricted = await book(request, owner, "受限固定资料", team, true);
  await pin(viewer, restricted.id, true, 403);
  await api(
    request,
    "POST",
    `spaces/${restricted.id}/members`,
    { user_id: viewer.id, role: "viewer" },
    owner,
  );
  await pin(viewer, restricted.id, true);
  expect(
    (await libraries(owner)).find((b: any) => b.id === restricted.id)
      .sidebar_pinned,
  ).toBe(false);
  let visible = (await libraries(viewer)).find(
    (b: any) => b.id === restricted.id,
  );
  expect(visible.sidebar_pinned).toBe(true);
  expect(visible.pinned).toBe(false);
  await api(
    request,
    "PATCH",
    `spaces/${restricted.id}`,
    { pinned: true },
    owner,
  );
  await pin(viewer, restricted.id, false);
  visible = (await libraries(viewer)).find((b: any) => b.id === restricted.id);
  expect(visible.sidebar_pinned).toBe(false);
  expect(visible.pinned).toBe(true);
  await pin(viewer, restricted.id, true);
  await api(
    request,
    "POST",
    `spaces/${restricted.id}/members`,
    { user_id: viewer.id, role: null },
    owner,
  );
  expect(
    (await libraries(viewer)).some((b: any) => b.id === restricted.id),
  ).toBe(false);
  await pin(viewer, restricted.id, true, 403);
  await pin(owner, restricted.id, true);
  await api(request, "DELETE", `spaces/${restricted.id}`, undefined, owner);
  expect(
    (await libraries(owner)).some((b: any) => b.id === restricted.id),
  ).toBe(false);
  await pin(owner, restricted.id, true, 403);
  await api(
    request,
    "POST",
    `spaces/${restricted.id}/restore-deleted`,
    {},
    owner,
  );
  expect(
    (await libraries(owner)).find((b: any) => b.id === restricted.id)
      .sidebar_pinned,
  ).toBe(true);
  await api(request, "DELETE", `spaces/${restricted.id}`, undefined, owner);
  const deleted = (
    await api(request, "GET", "trash/spaces", undefined, owner)
  ).find((b: any) => b.id === restricted.id);
  await api(
    request,
    "DELETE",
    `trash/spaces/${restricted.id}`,
    { deletion_token: deleted.trash_batch },
    owner,
  );
  expect(
    (await libraries(owner)).some((b: any) => b.id === restricted.id),
  ).toBe(false);
});

test("侧栏固定优先并补充活跃知识库，个人与团队入口对齐；取消固定保留当前编辑器", async ({
  page,
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root);
  const team = await api(request, "POST", "teams", { name: "示例" }, owner);
  const personal = await book(request, owner, "常用个人库"),
    unused = await book(request, owner, "不常用资料"),
    shared = await book(request, owner, "常用团队库", team);
  const note = await api(
    request,
    "POST",
    "documents",
    { space_id: personal.id, title: "固定侧栏验证" },
    owner,
  );
  const welcome = await api(
    request,
    "POST",
    "documents",
    { space_id: shared.id, title: "欢迎介绍", visibility: "team" },
    owner,
  );
  const exported = await api(
    request,
    "GET",
    `documents/${welcome.id}/export`,
    undefined,
    owner,
  );
  await api(
    request,
    "POST",
    `documents/${welcome.id}/import`,
    {
      markdown: exported.markdown.replace(
        "\n<!-- /anote:block -->",
        "欢迎加入 示例，共享研究资料。\n<!-- /anote:block -->",
      ),
      opId: randomUUID(),
    },
    owner,
  );
  await api(
    request,
    "PATCH",
    `teams/${team.id}`,
    { announcement_doc_id: welcome.id },
    owner,
  );
  await api(request, "PATCH", `spaces/${shared.id}`, { pinned: true }, owner);
  await login(page, owner);
  const sidebar = page.getByRole("complementary", { name: "知识库侧边栏" });
  await expect(sidebar.locator(".sidebar-library")).toHaveText([personal.name,shared.name]);
  const personalLabel = sidebar
    .getByTestId("personal-libraries").locator(":scope > span");
  const teamLabel = sidebar
    .locator(".knowledge-section-title > span")
    .filter({ hasText: "示例团队" });
  expect(
    Math.abs(
      (await personalLabel.boundingBox())!.x -
        (await teamLabel.boundingBox())!.x,
    ),
  ).toBeLessThan(1);
  await sidebar.getByTestId("personal-libraries").click();
  await page
    .locator(".library-card")
    .filter({ hasText: personal.name })
    .getByRole("button", { name: "固定到侧栏 " + personal.name, exact: true })
    .click();
  await expect(sidebar.locator(".sidebar-library")).toHaveText([personal.name,shared.name]);
  await sidebar.getByRole("button", { name: "示例团队", exact: true }).click();
  await expect(page.locator(".team-pinned")).toBeVisible();
  await expect(page.locator(".team-pinned")).toContainText(
    "欢迎介绍",
  );
  await page.locator(".team-hub .management-tabs").getByRole("button", { name: "设置", exact: true }).click();
  await sidebar.getByRole("button", { name: "示例团队", exact: true }).click();
  await expect(page.locator(".team-pinned")).toContainText(
    "欢迎介绍",
  );
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await page
    .locator(".library-card")
    .filter({ hasText: shared.name })
    .getByRole("button", { name: "固定到侧栏 " + shared.name, exact: true })
    .click();
  await expect(sidebar.locator(".sidebar-library")).toHaveCount(2);
  await expect(sidebar).not.toContainText(unused.name);
  await sidebar
    .locator(".sidebar-library")
    .filter({ hasText: personal.name })
    .click();
  await page.locator(".note-open").filter({ hasText: note.title }).click();
  await typeBody(page, "取消固定不能影响当前正文");
  await page
    .getByTestId("editor")
    .evaluate((el) => (el.dataset.pinCheck = "retained"));
  await sidebar
    .getByRole("button", { name: "取消固定 " + personal.name, exact: true })
    .click();
  await expect(page.getByTestId("editor")).toHaveAttribute(
    "data-pin-check",
    "retained",
  );
  await expect(sidebar.locator(".sidebar-library")).toHaveText([personal.name,shared.name]);
  await expect(sidebar.getByRole("button",{name:"固定到侧栏 "+personal.name,exact:true})).toHaveAttribute("aria-pressed","false");
  await expect(
    sidebar.locator(".catalog-tree,.catalog-note,.folder-open"),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "全部笔记", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("editor")).toContainText(
    "取消固定不能影响当前正文",
  );
  await expect(sidebar.locator(".sidebar-library")).toHaveText([personal.name,shared.name]);
  await page.getByRole("button", { name: "返回知识库", exact: true }).click();
  await expect(page.locator(".academic-page-header h1")).toHaveText(
    personal.name,
  );
  await expect(page.locator(".note-table-row")).toContainText(note.title);
  await page.screenshot({ path: "artifacts/web/sidebar-pins.png" });
});

async function noLightSurfaces(scope: Locator) {
  const bright = () =>
    scope.evaluate((root) =>
      [...root.querySelectorAll("*")]
        .filter((el) => {
          const box = el.getBoundingClientRect(),
            css = getComputedStyle(el);
          if (box.width < 24 || box.height < 14 || css.visibility === "hidden")
            return false;
          const rgba = css.backgroundColor.match(/[\d.]+/g)?.map(Number);
          return (
            rgba &&
            (rgba.length < 4 || rgba[3] > 0.95) &&
            rgba.slice(0, 3).every((n) => n > 200)
          );
        })
        .map((el) => ({
          tag: el.tagName,
          classes: el.className,
          background: getComputedStyle(el).backgroundColor,
        })),
    );
  // Theme attributes change before the button background transition finishes.
  await expect
    .poll(bright, { message: "暗黑模式不应残留大块浅色界面背景" })
    .toEqual([]);
}
async function readable(locator: Locator) {
  const contrast = await locator.first().evaluate((el) => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    const fg = rgb(getComputedStyle(el).color);
    let node: Element | null = el,
      bg = [0, 0, 0, 0];
    while (node && (bg[3] ?? 1) < 0.99) {
      bg = rgb(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    const luminance = (v: number[]) =>
      v
        .slice(0, 3)
        .map((n) => {
          n /= 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(fg),
      b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}
test("暗黑笔记列表标题、元信息与悬停行可读，Tab 使用透明底色和下划线", async ({
  page,
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root);
  const team = await api(
    request,
    "POST",
    "teams",
    { name: "对比度检查" },
    owner,
  );
  const library = await book(request, owner, "对比度知识库", team);
  const note = await api(
    request,
    "POST",
    "documents",
    { space_id: library.id, title: "笔记标题对比度", visibility: "team" },
    owner,
  );
  await api(request, "PATCH", "me/preferences", { theme: "dark" }, owner);
  await login(page, owner);
  const row = page.locator(".note-table-row").filter({ hasText: note.title });
  await expect(row).toBeVisible();
  await readable(row.locator(".note-open strong"));
  await readable(row.locator(".note-open small"));
  await readable(row.locator(".note-visibility"));
  await readable(row.locator("time"));
  await page.screenshot({ path: "artifacts/web/dark-notes-tabs.png" });
  await row.hover();
  await readable(row.locator(".note-open strong"));
  await noLightSurfaces(page.locator(".academic-workspace"));
  await row.locator(".note-open").focus();
  await readable(row.locator(".note-open strong"));
  const tabs = page.locator(".home-tabs button");
  for (let i = 0; i < (await tabs.count()); i++) {
    await expect(tabs.nth(i)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await page
    .locator(".home-tabs")
    .getByRole("button", { name: "团队", exact: true })
    .click();
  await expect(page.locator(".home-tabs button.active")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".home-tabs button.active")).toHaveCSS(
    "border-bottom-style",
    "solid",
  );
  await readable(page.locator(".home-tabs button.active"));
  await row.hover();
  await page.screenshot({ path: "artifacts/web/dark-notes-hover.png" });
});
test("暗黑设置、平台页签、成员表格、下载按钮和知识库卡片没有浅色残留且文字可读", async ({
  page,
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root, true);
  const team = await api(
    request,
    "POST",
    "teams",
    { name: "外观检查团队" },
    owner,
  );
  const shared = await book(request, owner, "外观团队库", team),
    personal = await book(request, owner, "外观个人库");
  const manifest = JSON.parse(
    await fs.readFile("artifacts/releases/manifest.json", "utf8"),
  );
  await page.route("**/api/client-releases", (route) =>
    route.fulfill({
      json: {
        ...manifest,
        packages: manifest.packages.map((item: any) => ({
          ...item,
          url: "/api/client-releases/" + item.file,
        })),
      },
    }),
  );
  await login(page, owner);
  await page.goto("/?space=" + shared.id);
  await expect(page.locator(".academic-page-header h1")).toHaveText(
    shared.name,
  );
  const sidebar = page.getByRole("complementary", { name: "知识库侧边栏" });
  await expect(
    sidebar.getByRole("button", { name: "平台管理", exact: true }),
  ).toHaveCount(0);
  await sidebar
    .locator(".academic-user")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await chooseTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await noLightSurfaces(settings);
  for (const button of await settings.locator(":scope > nav button").all()) {
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await button.hover();
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await readable(settings.locator("h2"));
  await readable(settings.locator(".profile-card h3"));
  await page.screenshot({ path: "artifacts/web/dark-settings-account.png" });
  await settings.getByRole("button", { name: "平台管理", exact: true }).click();
  await expect(
    settings.getByLabel("公共访问地址", { exact: true }),
  ).toBeVisible();
  await noLightSurfaces(settings);
  await expect(settings.locator(":scope > nav button.active")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(settings.locator(".management-tabs button.active")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await readable(settings.locator(".management-tabs button.active"));
  await page.screenshot({
    path: "artifacts/web/dark-settings-platform.png",
    mask: [settings.locator("input,textarea")],
    maskColor: "#263751",
  });
  await settings.getByRole("button", { name: "用户管理", exact: true }).click();
  await expect(settings.locator(".team-member").first()).toBeVisible();
  await noLightSurfaces(settings);
  await settings.getByRole("button", { name: "操作记录", exact: true }).click();
  await expect(settings.locator(".audit-list")).toBeVisible();
  await noLightSurfaces(settings);
  await expect(settings.getByRole("button",{name:"成员管理",exact:true})).toHaveCount(0);
  await settings
    .getByRole("button", { name: "桌面客户端", exact: true })
    .click();
  const downloads = settings.getByRole("table", { name: "桌面客户端下载" });
  await expect(downloads.locator("tbody tr")).toHaveCount(4);
  await expect(downloads.getByRole("columnheader")).toHaveText(["应用名称", "平台", "SHA-256", "下载"]);
  for (const item of manifest.packages) {
    const row = downloads.getByRole("row").filter({ hasText: item.file });
    await expect(row.getByRole("rowheader")).toHaveText(item.file);
    const platforms: Record<string, string> = { "linux-x64": "Linux", "win32-x64": "Windows", "darwin-x64": "macOS Intel", "darwin-arm64": "macOS Apple Silicon" };
    await expect(row.getByRole("cell").first()).toHaveText(platforms[item.platform + "-" + item.arch]);
    await expect(row.locator("code")).toHaveText(item.sha256);
    await expect(row.getByRole("link")).toHaveAttribute("href", "/api/client-releases/" + item.file);
    await expect(row.getByRole("link")).toHaveAttribute("download", item.file);
    await expect(row.locator("code")).toBeVisible();
  }
  await noLightSurfaces(settings);
  await readable(settings.locator(".client-package-name"));
  await readable(settings.locator(".client-download code"));
  await readable(settings.locator(".client-download a"));
  await page.screenshot({ path: "artifacts/web/dark-settings-clients.png" });
  await settings.getByRole("button", { name: "账号与偏好", exact: true }).click();
  await chooseTheme(page, "light");
  await settings.getByRole("button", { name: "桌面客户端", exact: true }).click();
  await readable(settings.locator(".client-package-name"));
  await readable(settings.locator(".client-download code"));
  await readable(settings.locator(".client-download a"));
  await page.screenshot({ path: "artifacts/web/light-settings-clients.png" });
  await page.setViewportSize({ width: 700, height: 950 });
  const list = settings.getByRole("region", { name: "客户端下载列表" });
  expect(await list.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await list.evaluate(el => el.scrollLeft = el.scrollWidth);
  await expect(downloads.locator("tbody tr").first().getByRole("link")).toBeInViewport();
  await page.screenshot({ path: "artifacts/web/narrow-settings-clients.png" });
  await page.setViewportSize({ width: 1580, height: 1150 });
  await settings.getByRole("button", { name: "账号与偏好", exact: true }).click();
  await chooseTheme(page, "dark");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await sidebar.getByTestId("personal-libraries").click();
  await expect(page.locator(".library-card")).toContainText(personal.name);
  await noLightSurfaces(page.locator(".academic-workspace"));
  await readable(page.locator(".library-card footer"));
  await page.screenshot({ path: "artifacts/web/dark-library-cards.png" });
  await sidebar.getByRole("button", { name: "我的团队", exact: false }).click();
  await expect(page.locator(".team-card").first()).toBeVisible();
  await noLightSurfaces(page.locator(".academic-workspace"));
  await page.locator(".team-directory .team-card").filter({hasText:team.name}).click();
  await page.getByRole("button",{name:"知识库",exact:true}).click();await page.getByRole("button",{name:"管理知识库 "+shared.name,exact:true}).click();await page.getByRole("button",{name:"权限分配",exact:true}).click();
  const permissions=page.getByRole("dialog",{name:"知识库权限",exact:true});await expect(permissions.locator(".member-table td").first()).toBeVisible();await noLightSurfaces(permissions);await readable(permissions.locator(".member-table th"));await readable(permissions.locator(".member-table td"));await page.screenshot({path:"artifacts/web/dark-library-permissions.png"});
});

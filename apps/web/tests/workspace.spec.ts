import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID, randomBytes } from "node:crypto";
import {
  api,
  admin,
  login,
  createLibrary,
  createNote,
  typeBody,
  slash,
  selectText,
} from "./helpers";
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts) await c.close();
  contexts.length = 0;
});
test("知识库列表、嵌套目录树、笔记移动与首页检索形成完整层级", async ({
  page,
  request,
}) => {
  await login(page);
  await expect(
    page.getByRole("heading", { name: "首页", exact: true }),
  ).toBeVisible();
  const name = "高斯重建 " + randomUUID().slice(0, 5),
    space = await createLibrary(page, name);
  await page
    .locator(".academic-page-actions")
    .getByRole("button", { name: "新建目录", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "新建目录" });
  await dialog.getByLabel("名称", { exact: true }).fill("研究项目");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByRole("button", { name: "管理目录 研究项目", exact: true })
    .click();
  await page.getByRole("button", { name: "新建子目录", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "新建目录" });
  await dialog.getByLabel("名称", { exact: true }).fill("实验记录");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".folder-open").filter({ hasText: "研究项目" }).click();
  await expect(page.locator(".folder-open").filter({ hasText: "实验记录" })).toHaveCount(0);
  await page.locator(".folder-open").filter({ hasText: "研究项目" }).click();
  await expect(page.locator(".folder-open").filter({ hasText: "实验记录" })).toBeVisible();
  const id = await createNote(page, "训练对比记录");
  await typeBody(page, "训练参数与最终结论。");
  await expect(
    page.locator(
      ".academic-sidebar .catalog-note,.academic-sidebar .catalog-tree",
    ),
  ).toHaveCount(0);
  await expect(page.locator(".editor-toolbar,.note-topbar")).toHaveCount(0);
  expect((await page.locator(".document-header").boundingBox())!.y).toBe(0);
  expect(
    (await page.locator(".note-workspace").boundingBox())!.width / 1580,
  ).toBeGreaterThan(0.8);
  await page.getByRole("button", {name:"隐藏笔记列表",exact:true}).click();
  expect((await page.locator(".document-region").boundingBox())!.width / 1580).toBeGreaterThan(0.8);
  const account = await admin(request),
    folders = await api(
      request,
      "GET",
      `spaces/${space}/folders`,
      undefined,
      account,
    ),
    child = folders.find((f: any) => f.name === "实验记录"),
    root = folders.find((f: any) => f.name === "研究项目");
  expect(
    (await api(request, "GET", `documents/${id}`, undefined, account))
      .folder_id,
  ).toBe(null);
  await page.getByRole("button", { name: "笔记更多操作" }).click();
  await page.getByRole("button", { name: "笔记设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "笔记设置" });
  await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(
    "训练对比记录",
  );
  await dialog.getByLabel("所在目录", { exact: true }).selectOption(root.id);
  await dialog.getByLabel("笔记标签", { exact: true }).fill("3DGS, 参数");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await api(request, "GET", `documents/${id}`, undefined, account))
          .folder_id,
    )
    .toBe(root.id);
  await page.getByRole("button", { name: "ANote", exact: true }).click();
  await page.getByLabel("搜索笔记", { exact: true }).fill("最终结论");
  await expect(
    page.locator(".note-table-row").filter({ hasText: name }),
  ).toBeVisible();
  await page.getByLabel("搜索笔记", { exact: true }).fill("不存在的检索内容");
  await expect(
    page.getByRole("heading", { name: "没有找到匹配的笔记", exact: true }),
  ).toBeVisible();
  await page
    .locator(".academic-sidebar-content")
    .getByTestId("personal-libraries")
    .click();
  await expect(
    page.locator(".library-card").filter({ hasText: name }),
  ).toContainText("2 个目录");
  await page.screenshot({
    path: "artifacts/web/academic-libraries.png",
    fullPage: true,
  });
  await page.locator(".library-open").filter({ hasText: name }).click();
  await page
    .locator(".note-table-row")
    .filter({ hasText: "训练对比记录" })
    .locator(".note-open")
    .click();
  await expect(page.getByTestId("editor")).toContainText("最终结论");
  await page.screenshot({
    path: "artifacts/web/academic-hierarchy.png",
    fullPage: true,
  });
});
test("斜线菜单支持 H1–H5、正文、列表和代码；选区浮动格式与对齐可持久化", async ({
  page,
}) => {
  await login(page);
  await createLibrary(page);
  await createNote(page, "表达与排版");
  for (let level = 1; level <= 5; level++) {
    await slash(page, "标题 " + level, "h" + level);
    await page.keyboard.insertText("标题层级 " + level);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("editor").locator("h" + level)).toHaveText(
      "标题层级 " + level,
    );
  }
  await slash(page, "正文", "正文");
  await page.keyboard.insertText("需要对齐和标记的段落");
  await selectText(page, ":scope > p", 0);
  const bubble = page.getByRole("toolbar", { name: "选区格式" });
  await expect(bubble).toBeVisible();
  await bubble.getByRole("button", { name: "对齐", exact: true }).click();
  await bubble.getByRole("button", { name: "居中对齐", exact: true }).click();
  await bubble.getByRole("button", { name: "加粗", exact: true }).click();
  await bubble.getByRole("button", { name: "斜体", exact: true }).click();
  await bubble.getByRole("button", { name: "删除线", exact: true }).click();
  const paragraph = page
    .getByTestId("editor")
    .locator(":scope > p")
    .filter({ hasText: "需要对齐和标记" })
    .first();
  await expect(paragraph).toHaveCSS("text-align", "center");
  await expect(
    paragraph.locator(
      "strong em s,strong s em,em strong s,em s strong,s strong em,s em strong",
    ),
  ).toContainText("需要对齐");
  await paragraph.click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await slash(page, "有序编号", "有序");
  await page.keyboard.insertText("编号一");
  await expect(page.getByTestId("editor").locator("ol li")).toContainText(
    "编号一",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await slash(page, "无序编号", "无序");
  await page.keyboard.insertText("项目一");
  await expect(page.getByTestId("editor").locator("ul li")).toContainText(
    "项目一",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await slash(page, "代码块", "代码");
  await page.keyboard.insertText('print("research")');
  await expect(page.getByTestId("editor").locator("pre")).toContainText(
    "research",
  );
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  await page.reload();
  await expect(page.getByTestId("editor").locator("h5")).toHaveText(
    "标题层级 5",
  );
  await expect(
    page
      .getByTestId("editor")
      .locator(":scope > p")
      .filter({ hasText: "需要对齐和标记" })
      .first(),
  ).toHaveCSS("text-align", "center");
  await page.screenshot({
    path: "artifacts/web/academic-editor.png",
    fullPage: true,
  });
});
test("多个账号实时协作、表格操作与只读成员评论", async ({
  page,
  browser,
  request,
}) => {
  const root = await admin(request),
    space = await api(
      request,
      "POST",
      "spaces",
      { name: "协作知识库 " + randomUUID().slice(0, 5), kind: "team" },
      root,
    ),
    people: any = {};
  for (const [key, role] of [
    ["alice", "editor"],
    ["bob", "editor"],
    ["carol", "reviewer"],
  ]) {
    const username = key + "-" + randomUUID().slice(0, 7),
      password = randomBytes(18).toString("hex"),
      user = await api(
        request,
        "POST",
        "users",
        { username, password, name: key },
        root,
      );
    const a = await api(request, "POST", "auth/login", { username, password });
    people[key] = { ...a, username, password };
    await api(
      request,
      "POST",
      `spaces/${space.id}/members`,
      { user_id: user.id, role },
      root,
    );
  }
  const note = await api(
    request,
    "POST",
    "documents",
    { space_id: space.id, title: "团队协作记录", visibility: "team" },
    people.alice,
  );
  await login(page, people.alice);
  await page.goto("/?doc=" + note.id);
  await expect(page.getByTestId("editor")).toBeVisible();
  await typeBody(page, "用于场景重建的共同记录。");
  const context = await browser.newContext({
    viewport: { width: 1580, height: 1150 },
  });
  contexts.push(context);
  const peer = await context.newPage();
  await login(peer, people.bob);
  await peer.goto("/?doc=" + note.id);
  await expect(peer.getByTestId("editor")).toBeVisible();
  await Promise.all([typeBody(page, "甲补充。"), typeBody(peer, "乙补充。")]);
  await expect(page.getByTestId("editor")).toContainText("乙补充");
  await expect(peer.getByTestId("editor")).toContainText("甲补充");
  await selectText(page, ":scope > p", 0);
  await page
    .getByRole("toolbar", { name: "选区格式" })
    .getByRole("button", { name: "文字颜色", exact: true })
    .click();
  await page.getByRole("button", { name: "文字色 紫色", exact: true }).click();
  await expect(
    peer.getByTestId("editor").locator("span[style]").first(),
  ).toHaveCSS("color", "rgb(124, 58, 237)");
  await page.getByTestId("editor").locator(":scope > p").last().click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await slash(page, "表格", "表格");
  const table = page.getByTestId("editor").locator("table");
  await table.locator("th").first().click();
  await page.keyboard.insertText("PSNR");
  await table.hover();
  await page.getByRole("button", { name: "选择第 1 行", exact: true }).click();
  await page
    .getByRole("toolbar", { name: "表格操作" })
    .getByRole("button", { name: "在下方插入行", exact: true })
    .click();
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(peer.getByTestId("editor").locator("table")).toContainText(
    "PSNR",
  );
  await page
    .locator(".document-actions")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await selectText(page, ":scope > p", 0);
  await page
    .getByRole("toolbar", { name: "选区格式" })
    .getByRole("button", { name: "添加批注", exact: true })
    .click();
  await page.getByLabel("评论内容", { exact: true }).fill("请核对训练配置。");
  await page.getByRole("button", { name: "添加评论", exact: true }).click();
  await expect(page.locator(".inspector-content")).toContainText(
    "请核对训练配置",
  );
  const ctx = await browser.newContext({
    viewport: { width: 1580, height: 1150 },
  });
  contexts.push(ctx);
  const reviewer = await ctx.newPage();
  await login(reviewer, people.carol);
  await reviewer.goto("/?doc=" + note.id);
  await expect(reviewer.getByTestId("editor")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await reviewer
    .locator(".document-actions")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await selectText(reviewer, ":scope > p", 0);
  await reviewer
    .getByRole("button", { name: "批注当前选区或段落", exact: true })
    .click();
  await reviewer
    .getByLabel("评论内容", { exact: true })
    .fill("评论建议：补充环境说明。");
  await reviewer.getByRole("button", { name: "添加评论", exact: true }).click();
  await expect(page.locator(".annotation-content")).toContainText(
    "评论建议：补充环境说明。",
  );
  await reviewer.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect(reviewer.getByTestId("editor")).toHaveAttribute(
    "contenteditable",
    "false",
  );
});
test("顶部历史入口、版本恢复和归档恢复", async ({ page }) => {
  await login(page);
  await createLibrary(page);
  await createNote(page, "阶段记录");
  await typeBody(page, "首轮实验已经完成。");
  await page
    .locator(".document-actions")
    .getByRole("button", { name: "历史版本", exact: true })
    .click();
  await expect(page.locator(".history-explanation")).toHaveCount(0);
  await page.getByRole("tab",{name:"命名版本",exact:true}).click();await page.getByLabel("版本号",{exact:true}).fill("v1.0");await page.getByLabel("版本说明", { exact: true }).fill("首轮保留");
  await page.getByRole("button", { name: "保存当前版本", exact: true }).click();
  await expect(page.locator(".inspector-content")).toContainText("首轮保留");
  await typeBody(page, "临时结论。");
  await page
    .locator(".inspector-content article")
    .filter({ hasText: "首轮保留" })
    .getByRole("button", { name: "查看版本", exact: true })
    .click();
  const preview = page.getByRole("dialog", { name: "历史版本预览" });
  await expect(preview.getByTestId("editor")).not.toContainText("临时结论");
  await preview
    .getByRole("button", { name: "恢复此版本", exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByTestId("editor")).not.toContainText("临时结论");
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.locator(".note-more>summary").click();
  await page.getByRole("button", { name: "笔记设置", exact: true }).click();
  await page.getByRole("button", { name: "归档笔记", exact: true }).click();
  await page
    .locator(".academic-page-actions")
    .getByRole("button", { name: "归档", exact: true })
    .click();
  await page
    .locator(".note-table-row")
    .filter({ hasText: "阶段记录" })
    .locator(".note-open")
    .click();
  await expect(page.getByTestId("editor")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await page.locator(".note-more>summary").click();
  await page.getByRole("button", { name: "笔记设置", exact: true }).click();
  await page.getByRole("button", { name: "取消归档", exact: true }).click();
});

import {editMapNode} from "./helpers";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import fs from "node:fs/promises";
import { api, admin, login, slash } from "./helpers";
test("旧版协作客户端被明确拒绝，不会改写新增公式或思维导图", async ({
  page,
  request,
}) => {
  const { owner, note } = await setup(page, request);
  let reason = "";
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    url:
      (process.env.BASE_URL || "http://anote.internal:3000").replace(
        /^http/,
        "ws",
      ) + "/collab",
    name: note.id,
    token: owner.token,
    document,
    onAuthenticationFailed: (event) => {
      reason = event.reason;
    },
  });
  try {
    await expect.poll(() => reason).toContain("编辑器格式已更新");
    expect(
      (await api(request, "GET", `documents/${note.id}`, undefined, owner))
        .snapshot.content[0].type,
    ).toBe("paragraph");
  } finally {
    provider.destroy();
    document.destroy();
  }
});
async function setup(page: Page, request: APIRequestContext) {
  const root = await admin(request),
    username = "editor-" + randomUUID().slice(0, 8),
    password = "Editor-extensions-123!";
  await api(
    request,
    "POST",
    "users",
    { username, password, name: username },
    root,
  );
  const owner = {
    ...(await api(request, "POST", "auth/login", { username, password })),
    username,
    password,
  };
  const book = await api(
    request,
    "POST",
    "spaces",
    { name: "编辑器验证", kind: "personal" },
    owner,
  );
  const note = await api(
    request,
    "POST",
    "documents",
    { space_id: book.id, title: "增强编辑器" },
    owner,
  );
  await login(page, owner);
  await page.goto("/?doc=" + note.id);
  await expect(page.getByTestId("editor")).toBeVisible();
  return { owner, book, note };
}
async function codeSource(page: Page, text: string) {
  await page.getByTestId("editor").evaluate((el, source) => {
    const editor = (el as any).editor;
    let target: any = null;
    editor.state.doc.descendants((node: any, pos: number) => {
      if (!target && node.type.name === "codeBlock") target = { node, pos };
    });
    editor.view.dispatch(
      editor.state.tr.insertText(
        source,
        target.pos + 1,
        target.pos + target.node.nodeSize - 1,
      ),
    );
  }, text);
}
test("代码块语言选择、语法高亮与重开／导出保留语言声明", async ({
  page,
  request,
}) => {
  const { owner, note } = await setup(page, request);
  await slash(page, "代码块");
  await page.getByLabel("代码语言").selectOption("python");
  await codeSource(page, "def train(x):\n  return x ** 2 # comment");
  await expect(
    page.locator(".academic-code-block .hljs-keyword").first(),
  ).toHaveText("def");
  await expect(page.locator(".academic-code-block .hljs-number")).toHaveText(
    "2",
  );
  await page.getByRole("button", { name: "复制代码", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await api(
            request,
            "GET",
            `documents/${note.id}/export`,
            undefined,
            owner,
          )
        ).markdown,
    )
    .toContain("```python");
  await page.reload();
  await expect(page.getByLabel("代码语言")).toHaveValue("python");
  await expect(page.locator(".hljs-keyword").first()).toHaveText("def");
  await page.screenshot({ path: "artifacts/web/code-highlight.png" });
});
test("Mermaid 图表源码编辑、语法错误恢复和沙箱内预览", async ({
  page,
  request,
}) => {
  const { owner, note } = await setup(page, request);
  await slash(page, "代码块", "mermaid");
  await page.getByLabel("代码语言").selectOption("mermaid");
  await codeSource(page, "flowchart LR\n  A[研究问题] --> B[实验设计]");
  await page.getByRole("button", { name: "预览图表", exact: true }).click();
  const diagram = page.frameLocator('iframe[title="Mermaid 图表"]');
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 30000 });
  await expect(page.locator('iframe[title="Mermaid 图表"]')).toHaveAttribute(
    "sandbox",
    "",
  );
  await page.getByRole("button", { name: "编辑源码", exact: true }).click();
  await codeSource(page, "flowchart LR\n  A[输入] --> B[结果]");
  await page.getByRole("button", { name: "预览图表", exact: true }).click();
  await expect(diagram.locator("svg")).toContainText("结果");
  await codeSource(page, "invalid diagram syntax");
  await expect(page.getByRole("alert")).toContainText("图表语法有误");
  await codeSource(page, "flowchart TD\n A[恢复显示] --> B[完成]");
  await expect(diagram.locator("svg")).toContainText("恢复显示");
  await codeSource(
    page,
    'flowchart LR\n A["<img src=x onerror=parent.mermaidExecuted=true>"] --> B[安全]\n click A "javascript:parent.mermaidExecuted=true"',
  );
  await expect(diagram.locator("svg")).toContainText("安全");
  await expect(diagram.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).mermaidExecuted),
  ).toBeUndefined();
  await codeSource(page, "flowchart TD\n A[恢复显示] --> B[完成]");
  await expect(diagram.locator("svg")).toContainText("恢复显示");
  await expect
    .poll(
      async () =>
        (
          await api(
            request,
            "GET",
            `documents/${note.id}/export`,
            undefined,
            owner,
          )
        ).markdown,
    )
    .toContain("```mermaid");
  await page.reload();
  await expect(diagram.locator("svg")).toContainText("恢复显示");
  await page.screenshot({ path: "artifacts/web/mermaid-preview.png" });
});
test("可视化思维导图增删分支、拖动、并行修改与重开保真", async ({
  page,
  request,
  browser,
}) => {
  const { owner, note } = await setup(page, request);
  await slash(page, "思维导图");
  const map = page.getByTestId("mind-map");
  await expect(map).toBeVisible();
  await expect(map.locator("[data-node-view-content]")).toBeHidden();
  await expect(page.getByTestId("editor").locator(".node-mindMap [data-node-view-content-react]")).toBeHidden();
  await editMapNode(map,0,"研究主题");
  await map.getByRole("button", { name: "添加子节点", exact: true }).click();
  await editMapNode(map,1,"第一分支");
  await map.locator(".mind-map-node").first().click();
  await map.getByRole("button", { name: "添加子节点", exact: true }).click();
  await editMapNode(map,2,"第二分支");
  const handle = map.locator(".mind-map-node").nth(1),
    before = (await handle.boundingBox())!;
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  // Move the whole node to a free row so the following text-edit action can
  // reach it without another branch covering its centre.
  await page.mouse.move(before.x + 65, before.y + 160, { steps: 8 });
  await page.mouse.up();
  expect((await handle.boundingBox())!.y - before.y).toBeGreaterThan(30);
  const context = await browser.newContext();
  try {
    const peer = await context.newPage();
    await login(peer, owner);
    await peer.goto("/?doc=" + note.id);
    await expect(peer.getByTestId("mind-map").locator(".mind-map-node")).toHaveCount(3);
    await Promise.all([
      editMapNode(map,1,"甲端更新"),
      editMapNode(peer.getByTestId("mind-map"),2,"乙端更新"),
    ]);
    await expect(map.locator(".mind-map-node-label").nth(2)).toHaveText("乙端更新");
    await expect(
      peer.getByTestId("mind-map").locator(".mind-map-node-label").nth(1),
    ).toHaveText("甲端更新");
    const snapshot = await map.evaluate((el) =>
      (el.closest('[data-testid="editor"]') as any).editor
        .getJSON()
        .content.find((n: any) => n.type === "mindMap"),
    );
    await page.reload();
    await expect(
      page.getByTestId("mind-map").locator(".mind-map-node-label").nth(1),
    ).toHaveText("甲端更新");
    const restored = await page
      .getByTestId("mind-map")
      .evaluate((el) =>
        (el.closest('[data-testid="editor"]') as any).editor
          .getJSON()
          .content.find((n: any) => n.type === "mindMap"),
      );
    expect(restored).toEqual(snapshot);
    await page.getByTestId("mind-map").locator(".mind-map-node").nth(2).click();
    await page.getByRole("button", { name: "删除分支", exact: true }).click();
    await expect(page.getByTestId("mind-map").locator(".mind-map-node")).toHaveCount(2);
  } finally {
    await context.close();
  }
  await page.screenshot({ path: "artifacts/web/visual-mind-map.png" });
});
test("LaTeX 独立与行内公式、源码编辑、网址识别和 Markdown 导出", async ({
  page,
  request,
}) => {
  const { owner, note } = await setup(page, request);
  await page.getByTestId("editor").locator("p").first().click();
  await page.keyboard.insertText("$$ X_t $$");
  await expect(page.locator(".math-block .katex")).toBeVisible();
  await page.locator(".math-block .math-render").click();
  await page.getByLabel("LaTeX 源码").fill(String.raw`X_t=\frac{1}{t}`);
  await page.getByRole("button", { name: "保存公式", exact: true }).click();
  // Atom insertion can end the document; ArrowDown creates an editable paragraph.
  await page.getByTestId("editor").press("ControlOrMeta+End");
  await page.keyboard.press("ArrowDown");
  await page.getByTestId("editor").evaluate((el) => {
    const e = (el as any).editor;
    e.commands.insertContentAt(e.state.doc.content.size, { type: "paragraph" });
    e.commands.focus("end");
  });
  await page.keyboard.insertText("正文 $a^2+b^2=c^2$");
  await expect(page.locator(".inline-math .katex")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.type(" https://example.org/paper ");
  await expect(
    page.getByTestId("editor").locator('a[href="https://example.org/paper"]'),
  ).toBeVisible();
  await page.keyboard.type(" www.example.org ");
  await expect(
    page.getByTestId("editor").locator('a[href="https://www.example.org"]'),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await api(
            request,
            "GET",
            `documents/${note.id}/export`,
            undefined,
            owner,
          )
        ).markdown,
    )
    .toContain(String.raw`X_t=\frac{1}{t}`);
  await page.reload();
  await expect(page.locator(".math-block .katex")).toBeVisible();
  await expect(page.locator(".inline-math .katex")).toBeVisible();
  await page.screenshot({ path: "artifacts/web/math-and-links.png" });
});
test("分类上传入口移除已有附件，文档与三维工程保留原件", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await page.getByTestId("editor").locator("p").first().click();
  await page.keyboard.insertText("/");
  const menu = page.getByRole("listbox", { name: "插入内容" });
  for (const name of ["图片", "音频", "视频", "附件", "三维文件／项目"])
    await expect(
      menu.getByRole("option", { name, exact: false }).first(),
    ).toBeVisible();
  await expect(
    menu.getByRole("option", { name: "已有附件", exact: false }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .getByTestId("editor")
    .evaluate((el) => (el as any).editor.commands.clearContent());
  await slash(page, "附件");
  const upload = page.getByLabel("上传附件文件", { exact: true });
  await expect(upload).toHaveAttribute(
    "accept",
    /\.pdf.*\.docx.*\.pptx.*\.xlsx/,
  );
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
  await upload.setInputFiles({
    name: "论文.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  const row = page.locator(".media-resource").filter({ hasText: "论文.pdf" });
  await expect(row).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await row.locator("a[download]").click();
  const downloaded = await downloadPromise;
  expect(await downloaded.failure()).toBeNull();
  const payload = await fs.readFile((await downloaded.path())!);
  const response = await page.request.get(
    (await row.locator("a[download]").getAttribute("href"))!,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain(
    "filename*=UTF-8''" + encodeURIComponent("论文.pdf"),
  );
  await expect(row.locator("a[download]")).toHaveAttribute(
    "download",
    "论文.pdf",
  );
  expect(payload.equals(pdf)).toBe(true);
  await row.getByRole("link", { name: "打开附件 论文.pdf",exact:true }).click();
  await expect(page.getByTitle("PDF 文档")).toBeVisible();
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await slash(page, "三维文件／项目", "三维");
  await upload.setInputFiles({
    name: "实验.blend",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("BLENDER-v430test-original"),
  });
  const project = page
    .locator(".media-resource")
    .filter({ hasText: "实验.blend" });
  await expect(project).toBeVisible();
  await project.getByRole("link", { name: "打开附件 实验.blend",exact:true }).click();
  await expect(page.getByRole("dialog", { name: "附件预览" })).toContainText(
    "此格式请使用本机应用打开",
  );
  const original=page.getByRole("dialog",{name:"附件预览"}).getByRole("link",{name:"打开原文件",exact:true});
  const source=await page.request.get((await original.getAttribute("href"))!);
  expect((await source.body()).toString()).toBe("BLENDER-v430test-original");
});

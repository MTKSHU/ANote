import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { api, admin, login, slash, chooseTheme } from "./helpers";

async function setup(page: Page, request: APIRequestContext) {
  const root = await admin(request), username = "blocks-" + randomUUID().slice(0, 8), password = "Block-selection-test-123!";
  await api(request, "POST", "users", { username, password, name: username }, root);
  const owner = { ...await api(request, "POST", "auth/login", { username, password }), username, password };
  const book = await api(request, "POST", "spaces", { name: "内容块操作", kind: "personal" }, owner);
  const note = await api(request, "POST", "documents", { space_id: book.id, title: "整块删除验证" }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id); await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByTestId("editor").locator("p").first().click(); await page.keyboard.insertText("块前保留"); await page.keyboard.press("Enter");
  return { root, owner, note };
}

for (const kind of ["code", "mermaid", "mindmap"] as const) {
  test(`${kind}：整块选中、Delete/Backspace、撤销与按钮删除，保留相邻正文并同步`, async ({ page, request, browser }) => {
    const { owner, note } = await setup(page, request);
    const label = kind === "mindmap" ? "思维导图" : kind === "mermaid" ? "Mermaid 图表" : "代码块";
    await slash(page, kind === "mindmap" ? "思维导图" : "代码块");
    const block = page.locator(kind === "mindmap" ? ".mind-map" : ".academic-code-block");
    if (kind === "mindmap") {
      await block.locator(".mind-map-node").first().dblclick(); const input = block.locator("input").first(); await input.fill("节点文字正常编辑"); await input.press("End"); await input.press("Backspace"); await expect(input).toHaveValue("节点文字正常编"); await input.press("Escape");
    } else {
      await page.getByLabel("代码语言").selectOption(kind === "mermaid" ? "mermaid" : "python");
      await block.locator("code").click();
      if (kind === "mermaid") { await page.keyboard.insertText("flowchart LR"); await page.keyboard.press("Enter"); await page.keyboard.insertText(" A[输入] --> B[输出]"); }
      else await page.keyboard.insertText("print(123)");
      if (kind === "mermaid") { await block.getByRole("button", { name: "预览图表", exact: true }).click(); await expect(page.frameLocator('iframe[title="Mermaid 图表"]').locator("svg")).toContainText("输出"); }
      else { await block.locator("code").click(); await page.keyboard.press("End"); await page.keyboard.press("Backspace"); await expect(block.locator("code")).toHaveText("print(123"); }
    }
    // Keep a real paragraph on either side of the selected block.
    await page.getByTestId("editor").evaluate(el => { const editor = (el as any).editor; editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "块后保留" }] }); });
    const context = await browser.newContext(), peer = await context.newPage();
    try {
      await login(peer, owner); await peer.goto("/?doc=" + note.id); await expect(peer.locator(kind === "mindmap" ? ".mind-map" : ".academic-code-block")).toHaveCount(1);
      const bounds = await page.getByTestId("editor").evaluate((el, type) => {
        const editor = (el as any).editor; let block: any;
        editor.state.doc.descendants((node: any, pos: number) => { if (node.type.name === type && !block) block = { node, pos }; });
        const before = editor.view.coordsAtPos(block.pos - 1), after = editor.view.coordsAtPos(block.pos + block.node.nodeSize + 1);
        return { before: { x: before.left, y: (before.top + before.bottom) / 2 }, after: { x: after.left, y: (after.top + after.bottom) / 2 } };
      }, kind === "mindmap" ? "mindMap" : "codeBlock");
      await page.mouse.move(bounds.before.x, bounds.before.y); await page.mouse.down(); await page.mouse.move(bounds.after.x, bounds.after.y, { steps: 12 }); await page.mouse.up();
      await page.keyboard.press("Delete"); await expect(block).toHaveCount(0);
      await expect(page.getByTestId("editor")).toContainText("块前保留"); await expect(page.getByTestId("editor")).toContainText("块后保留");
      await page.keyboard.press("ControlOrMeta+z"); await expect(block).toHaveCount(1);
      for (const key of ["Delete", "Backspace"]) {
        await block.getByRole("button", { name: "选中整个" + label, exact: true }).click();
        await expect(block).toHaveClass(/is-block-selected/);
        expect(await page.getByTestId("editor").evaluate(el => (el as any).editor.state.selection.toJSON().type)).toBe("node");
        await expect(page.getByRole("group", { name: "编辑工具", exact: true })).toHaveCount(0);
        await page.keyboard.press(key); await expect(block).toHaveCount(0);
        await expect(peer.locator(kind === "mindmap" ? ".mind-map" : ".academic-code-block")).toHaveCount(0);
        await expect(page.getByTestId("editor")).toContainText("块前保留"); await expect(page.getByTestId("editor")).toContainText("块后保留");
        await page.keyboard.press("ControlOrMeta+z"); await expect(block).toHaveCount(1);
      }
      if (kind === "mermaid") await block.locator(".mermaid-viewport").click({ position: { x: 30, y: 30 } });
      else if (kind === "mindmap") await block.getByRole("button",{name:"选中整个思维导图",exact:true}).click();
      else await block.locator(".code-block-header").click({ position: { x: 160, y: 20 } });
      await expect(block).toHaveClass(/is-block-selected/);
      await chooseTheme(page, "dark"); await expect(block).toHaveCSS("outline-style", "solid"); await page.screenshot({ path: `artifacts/web/block-selection-${kind}-dark.png`, animations: "disabled" });
      await block.getByRole("button", { name: "删除整个" + label, exact: true }).click(); await expect(block).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+s");
      await expect.poll(async () => JSON.stringify((await api(request, "GET", `documents/${note.id}`, undefined, owner)).snapshot)).not.toContain(kind === "mindmap" ? '"mindMap"' : '"codeBlock"');
      await page.reload(); await expect(page.getByTestId("editor")).toContainText("块后保留"); await expect(block).toHaveCount(0);
    } finally { await context.close(); }
  });
}

test("Mermaid 仅从代码块选择语言，空块可输入；只读笔记不显示整块删除操作", async ({ page, request, browser }) => {
  const { root, owner, note } = await setup(page, request);
  await page.keyboard.insertText("/mermaid"); const menu = page.getByRole("listbox", { name: "插入内容" }); await expect(menu.getByRole("option")).toHaveCount(1); await expect(menu.getByRole("option")).toContainText("代码块"); await menu.getByRole("option").click();
  await page.getByLabel("代码语言").selectOption("mermaid"); await expect(page.locator(".academic-code-block code")).toBeVisible(); await page.locator(".academic-code-block code").click(); await page.keyboard.insertText("flowchart LR"); await page.keyboard.press("Enter"); await page.keyboard.insertText(" A --> B"); await page.getByRole("button", { name: "预览图表", exact: true }).click(); await expect(page.frameLocator('iframe[title="Mermaid 图表"]').locator("svg")).toContainText("B");
  await page.getByTestId("editor").locator(":scope > p").first().click(); await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByRole("group", { name: "编辑工具", exact: true })).toBeVisible();
  await page.getByTestId("editor").locator(":scope > p").first().click();
  const username = "reader-" + randomUUID().slice(0, 8), password = "Read-only-blocks-123!";
  const user = await api(request, "POST", "users", { username, password, name: username }, root);
  const sharing = await api(request, "GET", `documents/${note.id}/sharing`, undefined, owner);
  await api(request, "PATCH", `documents/${note.id}/sharing`, { visibility: "private", access_revision: sharing.access_revision, collaborators: [{ user_id: user.id, role: "viewer" }] }, owner);
  const context = await browser.newContext();
  try {
    const peer = await context.newPage(); await login(peer, { username, password }); await peer.goto("/?doc=" + note.id); await expect(peer.locator(".academic-code-block")).toBeVisible(); await expect(peer.locator(".editor-block-actions")).toHaveCount(0); await expect(peer.getByLabel("代码语言")).toBeDisabled();
    await peer.locator(".research-editor").press("ControlOrMeta+a"); await peer.keyboard.press("Delete"); await expect(peer.locator(".academic-code-block")).toHaveCount(1);
  } finally { await context.close(); }
});

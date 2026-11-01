import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { api, login, chooseTheme } from "./helpers";
import { person } from "./mcp-helpers";

const source = "flowchart LR\n A[研究问题] --> B[实验设计] --> C[结果分析]\n B --> D[数据收集]";
async function setup(page: Page, request: APIRequestContext) {
  const owner = await person(request), book = await api(request, "POST", "spaces", { kind: "personal", name: "图表与标题层级" }, owner),
    note = await api(request, "POST", "documents", { space_id: book.id, title: "画布交互验证" }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id);
  await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
  await page.getByTestId("editor").evaluate((el, code) => (el as any).editor.commands.setContent({ type: "doc", content: [
    { type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: code }] }, { type: "paragraph" },
  ] }), source);
  const block = page.locator(".diagram-code-block"), canvas = block.locator(".mermaid-viewport");
  await expect(page.frameLocator('iframe[title="Mermaid 图表"]').locator("svg")).toContainText("结果分析");
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  return { owner, book, note, block, canvas };
}
async function view(page: Page) {
  return page.locator(".mermaid-viewport").evaluate(el => ({ zoom: Number(el.getAttribute("data-zoom")), x: Number(el.getAttribute("data-pan-x")), y: Number(el.getAttribute("data-pan-y")) }));
}
test("Mermaid 围绕指针缩放、整幅图拖动、按钮与键盘适应画布；视图不写入笔记", async ({ page, request }) => {
  const { owner, note, block, canvas } = await setup(page, request), initial = await view(page),
    hash = (await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash;
  await expect(block.locator("iframe")).toHaveAttribute("sandbox", "");
  await expect(block.locator("iframe")).toHaveCSS("pointer-events", "none");
  const box = (await canvas.boundingBox())!, px = box.width * .65, py = box.height * .4;
  const scroll = await page.locator(".document-region").evaluate(el => el.scrollTop);
  await page.mouse.move(box.x + px, box.y + py); await page.mouse.wheel(0, -220);
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(initial.zoom);
  const enlarged = await view(page), ratio = enlarged.zoom / initial.zoom;
  expect(enlarged.x).toBeCloseTo(px - (px - initial.x) * ratio, 0);
  expect(enlarged.y).toBeCloseTo(py - (py - initial.y) * ratio, 0);
  expect(await page.locator(".document-region").evaluate(el => el.scrollTop)).toBe(scroll);
  await page.mouse.down(); await page.mouse.move(box.x + px + 76, box.y + py + 44, { steps: 8 }); await page.mouse.up();
  const moved = await view(page); expect(moved.x).toBeCloseTo(enlarged.x + 76, 0); expect(moved.y).toBeCloseTo(enlarged.y + 44, 0);
  expect(moved.zoom).toBe(enlarged.zoom); await expect(canvas).not.toHaveClass(/is-panning/);
  await block.getByRole("button", { name: "缩小 Mermaid 图表", exact: true }).click();
  await expect.poll(async () => (await view(page)).zoom).toBeCloseTo(moved.zoom / 1.2, 3);
  await block.getByRole("button", { name: "适应 Mermaid 画布", exact: true }).click();
  expect(await view(page)).toEqual(initial);
  await canvas.focus(); await page.keyboard.press("+"); expect((await view(page)).zoom).toBeCloseTo(initial.zoom * 1.2, 3);
  await page.keyboard.press("0"); expect(await view(page)).toEqual(initial);
  for (const theme of ["dark", "light"] as const) {
    await chooseTheme(page, theme); await expect(page.locator("html")).not.toHaveClass(/theme-changing/);
    await expect.poll(() => block.locator("iframe").getAttribute("srcdoc")).toContain(theme === "dark" ? "#e5e9f0" : "#242833");
    const themed = await view(page), themedBox = (await canvas.boundingBox())!;
    expect(themed.zoom).toBe(initial.zoom);
    expect(themed.x - initial.x).toBeCloseTo((themedBox.width - box.width) / 2, 0);
    expect(themed.y - initial.y).toBeCloseTo((themedBox.height - box.height) / 2, 0);
    await expect(page.frameLocator('iframe[title="Mermaid 图表"]').locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(27, 34, 48)" : "rgb(255, 255, 255)");
    await block.screenshot({ path: `artifacts/web/mermaid-canvas-${theme}.png` });
  }
  await page.keyboard.press("ControlOrMeta+s");
  expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash).toBe(hash);
  await page.reload(); await expect(page.frameLocator('iframe[title="Mermaid 图表"]').locator("svg")).toContainText("结果分析");
  expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash).toBe(hash);
});
test("只读成员可浏览和移动 Mermaid 视图，不能改动源码；超大图可缩放并适应窗口", async ({ page, request, browser }) => {
  const { owner, note } = await setup(page, request), reader = await person(request),
    sharing = await api(request, "GET", `documents/${note.id}/sharing`, undefined, owner);
  const wide = "flowchart LR\n" + Array.from({ length: 18 }, (_, i) => `N${i}[研究步骤${i}] --> N${i + 1}`).join("\n");
  await page.getByTestId("editor").evaluate((el, text) => (el as any).editor.commands.setContent({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text }] }, { type: "paragraph" }] }), wide);
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  await api(request, "PATCH", `documents/${note.id}/sharing`, { visibility: "private", access_revision: sharing.access_revision, collaborators: [{ user_id: reader.user.id, role: "viewer" }] }, owner);
  const context = await browser.newContext();
  try {
    const peer = await context.newPage(); await login(peer, reader); await peer.goto("/?doc=" + note.id);
    const canvas = peer.locator(".mermaid-viewport"), block = peer.locator(".diagram-code-block");
    await expect(peer.frameLocator('iframe[title="Mermaid 图表"]').locator("svg")).toContainText("研究步骤17");
    await expect(peer.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    const initial = await view(peer), hash = (await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash;
    expect(initial.zoom).toBeLessThan(1); expect(initial.zoom).toBeGreaterThanOrEqual(.05);
    await expect(block.getByLabel("代码语言")).toBeDisabled(); await expect(block.locator(".editor-block-actions")).toHaveCount(0);
    await block.getByRole("button", { name: "放大 Mermaid 图表", exact: true }).click(); expect((await view(peer)).zoom).toBeGreaterThan(initial.zoom);
    const box = (await canvas.boundingBox())!; await peer.mouse.move(box.x + 40, box.y + 40); await peer.mouse.down(); await peer.mouse.move(box.x + 100, box.y + 70); await peer.mouse.up();
    expect((await view(peer)).x).not.toBe(initial.x);
    await peer.setViewportSize({ width: 950, height: 900 }); await block.getByRole("button", { name: "适应 Mermaid 画布", exact: true }).click();
    const geometry = await block.locator(".mermaid-stage").boundingBox(), resized = (await canvas.boundingBox())!;
    expect(geometry!.width).toBeLessThanOrEqual(resized.width - 30); expect(geometry!.x).toBeGreaterThanOrEqual(resized.x + 15);
    expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash).toBe(hash);
  } finally { await context.close(); }
});
test("文内目录以实际文字缩进区分 H2–H5，同级对齐，切换主题和阅读模式保持层级", async ({ page, request }) => {
  await setup(page, request);
  const headings = [{ level: 2, text: "范围与结论" }, { level: 3, text: "方案对比" }, { level: 4, text: "实验细节" }, { level: 2, text: "建议方案" }, { level: 5, text: "很长的补充标题用于验证省略显示与层级对齐" }];
  await page.getByTestId("editor").evaluate((el, entries) => (el as any).editor.commands.setContent({ type: "doc", content: entries.flatMap(entry => [
    { type: "heading", attrs: { level: entry.level }, content: [{ type: "text", text: entry.text }] },
    { type: "paragraph", content: [{ type: "text", text: "说明内容" }] },
  ]) }), headings);
  await page.getByRole("button", { name: "显示文内目录", exact: true }).click();
  const outline = page.getByRole("complementary", { name: "文内目录", exact: true });
  const geometry = () => outline.locator("nav button").evaluateAll(entries => entries.map(el => ({ level: Number(el.getAttribute("data-heading-level")), x: el.querySelector("span")!.getBoundingClientRect().x })));
  for (const mode of ["编辑", "阅读"]) {
    if (mode === "阅读") await page.getByRole("button", { name: "阅读", exact: true }).click();
    for (const theme of ["light", "dark"] as const) {
      await chooseTheme(page, theme); await expect(outline.locator("nav button")).toHaveCount(5);
      const actual = await geometry();
      for (let i = 0; i < headings.length; i++) expect(actual[i].x - actual[0].x).toBeCloseTo((headings[i].level - 2) * 20, 0);
      await expect(outline.locator("nav button small")).toHaveCount(0);
      await expect(outline.locator("nav button").nth(4)).toHaveText(headings[4].text);
      await outline.screenshot({ path: `artifacts/web/outline-depth-${mode}-${theme}.png` });
    }
  }
  await outline.getByRole("button", { name: "实验细节", exact: true }).click();
  await expect(page.getByTestId("editor").locator("h4")).toBeInViewport();
});

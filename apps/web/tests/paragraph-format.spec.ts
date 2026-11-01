import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { api, login, chooseTheme } from "./helpers";
import { person } from "./mcp-helpers";
async function setup(page: Page, request: APIRequestContext) {
  const owner = await person(request), book = await api(request, "POST", "spaces", { kind: "personal", name: "段落格式" }, owner),
    note = await api(request, "POST", "documents", { space_id: book.id, title: "可视化标题" }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id); await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
  return { owner, note };
}
async function format(page: Page, name: string) {
  await page.getByRole("button", { name: /^段落格式：/ }).click();
  await page.getByRole("menu", { name: "段落格式", exact: true }).getByRole("menuitemradio", { name, exact: true }).click();
}
test("已有标题可切换正文与 H1–H5，保留文字、标记、对齐、块 ID，支持撤销和阅读隐藏", async ({ page, request }) => {
  await setup(page, request); const editor = page.getByTestId("editor");
  await editor.evaluate(el => (el as any).editor.commands.setContent({ type: "doc", content: [
    { type: "heading", attrs: { blockId: "original-heading", level: 2, textAlign: "center" }, content: [{ type: "text", text: "保留格式的标题", marks: [{ type: "bold" }, { type: "italic" }] }] },
    { type: "paragraph", content: [{ type: "text", text: "后续正文" }] },
  ] }));
  const original = await editor.evaluate(el => (el as any).editor.getJSON().content[0]);
  await editor.locator("h2").click(); await expect(page.getByRole("button", { name: "段落格式：标题 2", exact: true })).toBeVisible();
  await format(page, "正文"); await expect(editor.locator(":scope > p").first()).toHaveText("保留格式的标题");
  for (const level of [1, 3, 5, 2, 4]) {
    await format(page, "标题 " + level); await expect(editor.locator("h" + level)).toHaveText("保留格式的标题");
    const current = await editor.evaluate(el => (el as any).editor.getJSON().content[0]);
    expect(current.content).toEqual(original.content); expect(current.attrs.blockId).toBe(original.attrs.blockId); expect(current.attrs.textAlign).toBe("center");
  }
  await expect(editor).toBeFocused(); await page.keyboard.press("ControlOrMeta+z"); await expect(editor.locator("h2")).toHaveText("保留格式的标题");
  await page.getByRole("button", { name: /^段落格式：/ }).click(); await page.keyboard.press("Escape"); await expect(page.getByRole("menu", { name: "段落格式", exact: true })).toHaveCount(0); await expect(editor).toBeFocused();
  for (const theme of ["dark", "light"] as const) { await chooseTheme(page, theme); await editor.locator("h2").click(); await page.getByRole("button", { name: /^段落格式：/ }).click(); await expect(page.getByRole("menuitemradio", { name: "标题 2", exact: true })).toHaveAttribute("aria-checked", "true"); await page.screenshot({ path: `artifacts/web/paragraph-format-${theme}.png` }); await page.keyboard.press("Escape"); }
  await page.getByRole("button", { name: "阅读", exact: true }).click(); await expect(editor).toHaveAttribute("contenteditable", "false"); await expect(page.locator(".paragraph-format-control")).toHaveCount(0);
});
test("表格中的当前段落可改标题并协同，不影响相邻单元格；代码块不显示段落格式菜单", async ({ page, request, browser }) => {
  const { owner, note } = await setup(page, request), editor = page.getByTestId("editor");
  await editor.evaluate(el => (el as any).editor.commands.setContent({ type: "doc", content: [
    { type: "table", content: [{ type: "tableRow", content: ["表内标题", "相邻单元格"].map(text => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })) }] },
    { type: "codeBlock", content: [{ type: "text", text: "console.log('code')" }] }, { type: "paragraph" },
  ] }));
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  const context = await browser.newContext();
  try {
    const peer = await context.newPage(); await login(peer, owner); await peer.goto("/?doc=" + note.id); await expect(peer.getByTestId("editor").locator("td")).toHaveCount(2);
    await editor.locator("td p").first().click(); await format(page, "标题 3");
    await expect(editor.locator("td h3")).toContainText("表内标题"); await expect(editor.locator("td").nth(1).locator("p")).toContainText("相邻单元格"); await expect(peer.getByTestId("editor").locator("td h3")).toContainText("表内标题");
    expect(await peer.getByTestId("editor").evaluate(el => (el as any).editor.getJSON().content[0].content[0].content[0].content[0].content[0].text)).toBe("表内标题");
    await editor.locator("code").click(); await expect(page.locator(".paragraph-format-control")).toHaveCount(0);
  } finally { await context.close(); }
});

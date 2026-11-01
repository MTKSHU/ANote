import { test, expect } from "@playwright/test";
import { api, login, chooseTheme } from "./helpers";
import { person } from "./mcp-helpers";

test("暗黑引用使用主题底色与清晰文字，嵌套引用、阅读模式和主题切换保持内容", async ({ page, request }) => {
  const owner = await person(request), book = await api(request, "POST", "spaces", { kind: "personal", name: "引用样式" }, owner),
    note = await api(request, "POST", "documents", { space_id: book.id, title: "引用与正文" }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id);
  const editor = page.getByTestId("editor"); await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.evaluate(el => (el as any).editor.commands.setContent({ type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "欢迎使用ANote" }] },
    { type: "paragraph", content: [{ type: "text", text: "正文与引用应协调，并保持阅读对比。" }] },
    { type: "blockquote", content: [
      { type: "paragraph", content: [{ type: "text", text: "从一个想法开始：记录、整理、展示，再把信息交给需要的人。" }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "嵌套引用，保留层次。" }] }] },
    ] }, { type: "paragraph", content: [{ type: "text", text: "引用之后继续记录。" }] },
  ] }));
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  const hash = (await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash;
  for (const mode of ["编辑", "阅读"]) {
    if (mode === "阅读") await page.getByRole("button", { name: "阅读", exact: true }).click();
    await chooseTheme(page, "dark"); await expect(page.locator("html")).not.toHaveClass(/theme-changing/);
    await expect(editor.locator("blockquote")).toHaveCount(2);
    for (const quote of await editor.locator("blockquote").all()) {
      const colors = await quote.evaluate(el => {
        const style = getComputedStyle(el), paragraph = getComputedStyle(el.querySelector("p")!);
        const rgb = (value: string) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const luminance = (value: number[]) => value.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const fg = luminance(rgb(paragraph.color)), bg = luminance(rgb(style.backgroundColor));
        return { background: style.backgroundColor, color: paragraph.color, border: style.borderLeftColor, contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
      });
      expect(colors.background).toBe("rgb(34, 44, 59)"); expect(colors.color).toBe("rgb(229, 233, 240)");
      expect(colors.border).not.toBe(colors.background); expect(colors.contrast).toBeGreaterThan(7);
    }
    await editor.locator(":scope > blockquote").screenshot({ path: `artifacts/web/blockquote-${mode}-dark.png` });
    await chooseTheme(page, "light");
    await expect(editor.locator(":scope > blockquote")).toHaveCSS("background-color", "rgb(250, 251, 254)");
    await expect(editor).toContainText("从一个想法开始：记录、整理、展示，再把信息交给需要的人。");
  }
  expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash).toBe(hash);
  expect((await api(request, "GET", `documents/${note.id}/export`, undefined, owner)).markdown).toContain("> 从一个想法开始");
});

import { test, expect } from "@playwright/test";
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

test("移动选区或折叠光标后立即回车保留正文，选区回车仍可替换文本", async ({ page }) => {
  await login(page);
  await createLibrary(page);
  await createNote(page, "快速光标移动");
  await typeBody(page, "共同记录不能因快速回车丢失。");
  await selectText(page);
  await page.getByTestId("editor").evaluate((el) => {
    // Reproduce an arrow-key collapse before the browser's asynchronous
    // selectionchange notification reaches ProseMirror.
    const selection = getSelection()!;
    selection.collapseToEnd();
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByTestId("editor")).toContainText(
    "共同记录不能因快速回车丢失。",
  );
  await expect(page.getByTestId("editor").locator(":scope > p")).toHaveCount(2);
  await page.getByTestId("editor").evaluate(el=>{
    const editor=(el as any).editor;
    editor.commands.setTextSelection(4);
    const range=document.createRange();range.selectNodeContents(el.querySelector(":scope > p")!);range.collapse(false);
    const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);
    // End can move the DOM caret while the model still has a collapsed
    // position in the middle of the paragraph.
    el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true,cancelable:true}));
  });
  await expect(page.getByTestId("editor").locator(":scope > p").first()).toHaveText("共同记录不能因快速回车丢失。");
  await expect(page.getByTestId("editor").locator(":scope > p")).toHaveCount(3);
  await selectText(page, ":scope > p", 0);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("editor")).not.toContainText(
    "共同记录不能因快速回车丢失。",
  );
});

test("无原生斜体的中文字体仍显示倾斜字形，格式在重开和阅读时保留", async ({
  page,
  request,
}) => {
  await login(page);
  await createLibrary(page);
  const id = await createNote(page, "中文斜体渲染");
  await typeBody(page, "中文斜体应当倾斜 Italic text");
  await selectText(page);
  await page
    .getByRole("toolbar", { name: "选区格式" })
    .getByRole("button", { name: "斜体", exact: true })
    .click();
  const paragraph = page
    .getByTestId("editor")
    .locator(":scope > p")
    .filter({ hasText: "中文斜体" })
    .first();
  await expect(paragraph.locator("em")).toHaveText(
    "中文斜体应当倾斜 Italic text",
  );
  const root = await admin(request);
  await expect
    .poll(async () =>
      JSON.stringify(
        (await api(request, "GET", `documents/${id}`, undefined, root))
          .snapshot,
      ),
    )
    .toContain('"italic"');
  await page.reload();
  await expect(paragraph.locator("em")).toBeVisible();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.evaluate(async () => {
    const font = new FontFace("RegularOnlyCJK", 'local("WenQuanYi Zen Hei")', {
      style: "normal",
      weight: "400",
    });
    document.fonts.add(await font.load());
    getSelection()?.removeAllRanges();
  });
  await page.addStyleTag({
    content: ".research-editor {font-family:RegularOnlyCJK !important;}",
  });
  const italic = await paragraph.screenshot({
    caret: "hide",
    animations: "disabled",
  });
  const normalStyle = await page.addStyleTag({
    content: ".research-editor em {font-style:normal !important;}",
  });
  const normal = await paragraph.screenshot({
    caret: "hide",
    animations: "disabled",
  });
  await normalStyle.evaluate((el) => el.remove());
  expect(italic.equals(normal), "倾斜字形应与普通字形产生可见差异").toBe(false);
  await page.screenshot({
    path: "artifacts/web/academic-italic-rendering.png",
  });
});

test("选区字号、文字色、高亮支持自定义、单项恢复和清除，重开与版本预览保真", async ({
  page,
}) => {
  await login(page);
  await createLibrary(page);
  await createNote(page, "选区格式验证");
  await typeBody(page, "突出结论，普通说明。");
  const paragraph = () =>
    page
      .getByTestId("editor")
      .locator(":scope > p")
      .filter({ hasText: "突出结论" })
      .first();
  await paragraph().click();
  await paragraph().evaluate((el) => {
    const text = el.firstChild!,
      range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  const toolbar = page.getByRole("toolbar", { name: "选区格式" });
  await toolbar.getByRole("button", { name: "字号", exact: true }).click();
  await page
    .getByRole("dialog", { name: "字号设置" })
    .getByRole("button", { name: "20 px", exact: true })
    .click();
  await toolbar.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByRole("button", { name: "文字色 红色", exact: true }).click();
  await toolbar.getByRole("button", { name: "背景颜色", exact: true }).click();
  await page.getByRole("button", { name: "背景色 黄色", exact: true }).click();
  let span = paragraph().locator("span[style]").filter({ hasText: "突出结论" });
  await expect(span).toHaveCSS("color", "rgb(220, 38, 38)");
  await expect(span).toHaveCSS("font-size", "20px");
  await expect(span).toHaveCSS("background-color", "rgb(254, 240, 138)");
  expect(
    await paragraph().evaluate(
      (el) =>
        Array.from(el.childNodes).find((n) =>
          n.textContent?.includes("普通说明"),
        )?.nodeType,
    ),
  ).toBe(3);
  await toolbar.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByLabel("颜色值", { exact: true }).fill("#123abc");
  await page
    .getByRole("dialog", { name: "文字颜色设置" })
    .getByRole("button", { name: "应用", exact: true })
    .click();
  await expect(span).toHaveCSS("color", "rgb(18, 58, 188)");
  await page.screenshot({
    path: "artifacts/web/academic-selection-toolbar.png",
    fullPage: true,
  });
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  await page.reload();
  await expect(span).toHaveCSS("color", "rgb(18, 58, 188)");
  await expect(span).toHaveCSS("font-size", "20px");
  await expect(span).toHaveCSS("background-color", "rgb(254, 240, 138)");
  await page
    .locator(".document-actions")
    .getByRole("button", { name: "历史版本", exact: true })
    .click();
  await page.getByRole("tab",{name:"命名版本",exact:true}).click();await page.getByLabel("版本号",{exact:true}).fill("v1.0");await page.getByLabel("版本说明", { exact: true }).fill("带颜色字号高亮");
  await page.getByRole("button", { name: "保存当前版本", exact: true }).click();
  await page
    .locator(".inspector-content article")
    .filter({ hasText: "带颜色字号高亮" })
    .getByRole("button", { name: "查看版本", exact: true })
    .click();
  const preview = page.getByRole("dialog", { name: "历史版本预览" });
  await expect(
    preview
      .getByTestId("editor")
      .locator("span[style]")
      .filter({ hasText: "突出结论" }),
  ).toHaveCSS("font-size", "20px");
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  // Individual resets retain the other attributes on the same selected range.
  await selectText(page);
  await toolbar.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByRole("button", { name: "默认文字颜色", exact: true }).click();
  await expect(span).not.toHaveCSS("color", "rgb(18, 58, 188)");
  await expect(span).toHaveCSS("font-size", "20px");
  await expect(span).toHaveCSS("background-color", "rgb(254, 240, 138)");
  await toolbar.getByRole("button", { name: "背景颜色", exact: true }).click();
  await page.getByRole("button", { name: "无背景颜色", exact: true }).click();
  await expect(span).toHaveCSS("font-size", "20px");
  await expect(span).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await toolbar.getByRole("button", { name: "字号", exact: true }).click();
  await page.getByRole("button", { name: "默认字号", exact: true }).click();
  await expect(paragraph().locator("span")).toHaveCount(0);
  await toolbar.getByRole("button", { name: "加粗", exact: true }).click();
  await toolbar.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByRole("button", { name: "文字色 蓝色", exact: true }).click();
  await toolbar.getByRole("button", { name: "清除格式", exact: true }).click();
  await expect(paragraph().locator("strong,span")).toHaveCount(0);
  await expect(paragraph()).toHaveText("突出结论，普通说明。");
});

test("表格图标支持上下左右插入、行列删除、合并拆分及不可用状态", async ({
  page,
}) => {
  await login(page);
  await createLibrary(page);
  await createNote(page, "表格图标验证");
  await slash(page, "表格", "表格");
  const table = page.getByTestId("editor").locator("table"),
    tools = page.getByRole("toolbar", { name: "表格操作" });
  await table.locator("th").last().click();
  await page.keyboard.insertText("保留内容");
  await table.locator("td").first().click();
  await expect(tools).toHaveCount(0);
  await table.hover();
  await page.getByRole("button", { name: "选择第 2 行", exact: true }).click();
  await expect(
    tools.getByRole("button", { name: "合并单元格", exact: true }),
  ).toBeEnabled();
  await expect(
    tools.getByRole("button", { name: "拆分单元格", exact: true }),
  ).toBeDisabled();
  for (const label of ["在上方插入行", "在下方插入行"])
    await tools.getByRole("button", { name: label, exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(5);
  await tools.getByRole("button", { name: "删除行", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(4);
  await table.hover();
  await page.getByRole("button", { name: "选择第 1 列", exact: true }).click();
  for (const label of ["在左侧插入列", "在右侧插入列"])
    await tools.getByRole("button", { name: label, exact: true }).click();
  await expect(table.locator("tr").first().locator("th,td")).toHaveCount(5);
  await tools.getByRole("button", { name: "删除列", exact: true }).click();
  await expect(table.locator("tr").first().locator("th,td")).toHaveCount(4);
  const cells = table.locator("tr").last().locator("td,th");
  await cells.nth(0).click();
  await page.keyboard.insertText("左格");
  await cells.nth(1).click();
  await page.keyboard.insertText("右格");
  const a = (await cells.nth(0).boundingBox())!,
    b = (await cells.nth(1).boundingBox())!;
  await page.mouse.move(a.x + 10, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(table.locator(".selectedCell")).toHaveCount(2);
  await expect(
    tools.getByRole("button", { name: "合并单元格", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "artifacts/web/academic-table-toolbar.png",
    fullPage: true,
  });
  await tools.getByRole("button", { name: "合并单元格", exact: true }).click();
  await expect(table.locator('[colspan="2"]')).toHaveCount(1);
  await expect(table.locator('[colspan="2"]')).toContainText("左格");
  await expect(table.locator('[colspan="2"]')).toContainText("右格");
  await expect(
    tools.getByRole("button", { name: "拆分单元格", exact: true }),
  ).toBeEnabled();
  await tools.getByRole("button", { name: "拆分单元格", exact: true }).click();
  await expect(table.locator('[colspan="2"]')).toHaveCount(0);
  await expect(table.locator("tr").last().locator("td,th")).toHaveCount(4);
  await expect(table).toContainText("保留内容");
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  await page.reload();
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table).toContainText("保留内容");
});

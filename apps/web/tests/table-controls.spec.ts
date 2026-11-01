import { test, expect, type Page, type Locator } from "@playwright/test";
import { login, createLibrary, createNote, slash } from "./helpers";
async function setup(page: Page) {
  await login(page);
  await createLibrary(page);
  await createNote(page, "表格边缘操作");
  await slash(page, "表格", "表格");
  return page.getByTestId("editor").locator("table");
}
async function columnBoundary(page: Page, table: Locator, index: number) {
  await table.hover();
  const cells = table.locator("tr").last().locator("td,th"),
    count = await cells.count(),
    rect = (await cells.nth(Math.min(index, count - 1)).boundingBox())!,
    box = (await table.boundingBox())!;
  await page.mouse.move(
    index === count ? rect.x + rect.width : rect.x,
    box.y - 13,
  );
}
async function rowBoundary(page: Page, table: Locator, index: number) {
  await table.hover();
  const rows = table.locator("tr"),
    count = await rows.count(),
    rect = (await rows.nth(Math.min(index, count - 1)).boundingBox())!,
    box = (await table.boundingBox())!;
  await page.mouse.move(
    box.x - 13,
    index === count ? rect.y + rect.height : rect.y,
  );
}
async function drag(page: Page, a: Locator, b: Locator) {
  const x = (await a.boundingBox())!,
    y = (await b.boundingBox())!;
  await page.mouse.move(x.x + 10, x.y + x.height / 2);
  await page.mouse.down();
  await page.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("单元格输入不弹工具箱，边缘插入行列保持光标与内容位置", async ({
  page,
}) => {
  const table = await setup(page),
    bar = page.getByRole("group", { name: "表格选区工具" });
  await table.locator("tr").nth(1).locator("td").first().click();
  await page.keyboard.insertText("光标");
  await expect(bar).toHaveCount(0);
  await columnBoundary(page, table, 1);
  await expect(
    page.getByRole("button", { name: "在第 2 列前插入", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/web/table-hover-column.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "在第 2 列前插入", exact: true })
    .click();
  await expect(table.locator("tr").first().locator("th,td")).toHaveCount(4);
  await expect(bar).toHaveCount(0);
  await page.keyboard.insertText("继续");
  await expect(table.locator("tr").nth(1).locator("td,th").first()).toHaveText(
    "光标继续",
  );
  await expect(table.locator("tr").nth(1).locator("td,th").nth(1)).toHaveText(
    "",
  );
  await rowBoundary(page, table, 1);
  await page
    .getByRole("button", { name: "在第 2 行前插入", exact: true })
    .click();
  await expect(table.locator("tr")).toHaveCount(4);
  await page.keyboard.insertText("原位");
  await expect(table.locator("tr").nth(2).locator("td,th").first()).toHaveText(
    "光标继续原位",
  );
  await expect(bar).toHaveCount(0);
  await columnBoundary(page, table, 4);
  await page
    .getByRole("button", { name: "在表格末尾插入列", exact: true })
    .click();
  await rowBoundary(page, table, 4);
  await page
    .getByRole("button", { name: "在表格末尾插入行", exact: true })
    .click();
  await expect(table.locator("tr")).toHaveCount(5);
  await expect(table.locator("tr").first().locator("td,th")).toHaveCount(5);
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  await page.reload();
  await expect(table).toContainText("光标继续原位");
  await expect(table.locator("tr")).toHaveCount(5);
});

test("行列选择和整列格式保留范围；合并单元格边界插入与右键拆分正确", async ({
  page,
}) => {
  const table = await setup(page),
    tools = page.getByRole("toolbar", { name: "表格操作" }),
    formats = page.getByRole("toolbar", { name: "选区格式" });
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      await table.locator("tr").nth(r).locator("td,th").nth(c).click();
      await page.keyboard.insertText(`${r + 1}-${c + 1}`);
    }
  await table.hover();
  await page.getByRole("button", { name: "选择第 2 列", exact: true }).click();
  await expect(table.locator(".selectedCell")).toHaveCount(3);
  await formats.getByRole("button", { name: "字号", exact: true }).click();
  await page.getByRole("button", { name: "20 px", exact: true }).click();
  for (let r = 0; r < 3; r++) {
    await expect(
      table.locator("tr").nth(r).locator("td,th").nth(1).locator("span[style]"),
    ).toHaveCSS("font-size", "20px");
    await expect(
      table.locator("tr").nth(r).locator("td,th").first().locator("span"),
    ).toHaveCount(0);
  }
  await formats.getByRole("button", { name: "字号", exact: true }).click();
  await page.getByRole("button", { name: "默认字号", exact: true }).click();
  await expect(table.locator("span[style]")).toHaveCount(0);
  await formats.getByRole("button", { name: "对齐", exact: true }).click();
  await page.getByRole("button", { name: "居中对齐", exact: true }).click();
  for (let r = 0; r < 3; r++) {
    await expect(
      table.locator("tr").nth(r).locator("td,th").nth(1).locator("p"),
    ).toHaveCSS("text-align", "center");
    await expect(
      table.locator("tr").nth(r).locator("td,th").first().locator("p"),
    ).toHaveCSS("text-align", /^(left|start)$/);
  }
  await table.locator("tr").nth(1).locator("td,th").first().click();
  await drag(
    page,
    table.locator("tr").nth(1).locator("td,th").first(),
    table.locator("tr").nth(1).locator("td,th").nth(1),
  );
  await expect(table.locator(".selectedCell")).toHaveCount(2);
  await tools.getByRole("button", { name: "合并单元格", exact: true }).click();
  await columnBoundary(page, table, 1);
  await page
    .getByRole("button", { name: "在第 2 列前插入", exact: true })
    .click();
  await expect(table.locator('[colspan="3"]')).toHaveCount(1);
  await expect(table.locator('[colspan="3"]')).toContainText("2-1");
  await expect(table.locator('[colspan="3"]')).toContainText("2-2");
  await table.locator('[colspan="3"]').click();
  await expect(tools).toHaveCount(0);
  await table.locator('[colspan="3"]').click({ button: "right" });
  await tools.getByRole("button", { name: "拆分单元格", exact: true }).click();
  await expect(table.locator('[colspan="3"]')).toHaveCount(0);
  await expect(table.locator("tr").nth(1).locator("td,th")).toHaveCount(4);
  await table.locator("tr").nth(1).locator("td,th").first().click();
  await drag(
    page,
    table.locator("tr").nth(1).locator("td,th").first(),
    table.locator("tr").nth(2).locator("td,th").first(),
  );
  await tools.getByRole("button", { name: "合并单元格", exact: true }).click();
  await expect(table.locator('[rowspan="2"]')).toHaveCount(1);
  await rowBoundary(page, table, 2);
  await page
    .getByRole("button", { name: "在第 3 行前插入", exact: true })
    .click();
  await expect(table.locator('[rowspan="3"]')).toHaveCount(1);
  await tools.getByRole("button", { name: "拆分单元格", exact: true }).click();
  await expect(table.locator('[rowspan="3"]')).toHaveCount(0);
  await table.hover();
  await page.getByRole("button", { name: "选择第 2 行", exact: true }).click();
  await page
    .getByRole("button", { name: "选择第 4 行", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(table.locator(".selectedCell")).toHaveCount(12);
  await tools.getByRole("button", { name: "删除行", exact: true }).click();
  await expect(table.locator("tr")).toHaveCount(1);
  await expect(table).toContainText("1-1");
});

test("长表格操作栏停靠标题下方，滚动和改变窗口后不覆盖单元格", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const table = await setup(page),
    bar = page.getByRole("group", { name: "表格选区工具" }),
    tools = page.getByRole("toolbar", { name: "表格操作" });
  // Leave the narrow viewport available for the table rather than the
  // optional overlaid note navigator, which has its own interaction tests.
  await page.getByRole("button", { name: "隐藏笔记列表", exact: true }).click();
  await table.locator("tr").last().locator("td").first().click();
  await page.keyboard.insertText("长表格内容");
  await table.hover();
  await page.getByRole("button", { name: "选择第 3 行", exact: true }).click();
  for (let i = 0; i < 17; i++)
    await tools
      .getByRole("button", { name: "在下方插入行", exact: true })
      .click();
  await expect(table.locator("tr")).toHaveCount(20);
  await expect(bar).toHaveAttribute("data-placement", "header");
  const toolbarBox = (await bar.boundingBox())!,
    tableBox = (await table.boundingBox())!;
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(tableBox.y);
  await page.mouse.move(tableBox.x + 100, Math.min(tableBox.y + 200, 600));
  await page.mouse.wheel(0, 80);
  await expect
    .poll(async () => (await table.boundingBox())!.y)
    .toBeLessThan(tableBox.y - 60);
  const partlyClipped = (await table.boundingBox())!;
  await page.mouse.move(
    partlyClipped.x + partlyClipped.width / 3,
    partlyClipped.y - 13,
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator(".table-insert-button")).toHaveCount(0);
  await page.mouse.move(tableBox.x + 100, 400);
  await page.mouse.wheel(0, 520);
  await expect(bar).toHaveAttribute("data-placement", "header");
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(bar).toHaveAttribute("data-placement", "header");
  await page.screenshot({
    path: "artifacts/web/table-docked-toolbar.png",
    fullPage: false,
  });
  const cell = table.locator("tr").nth(15).locator("td,th").first();
  await cell.click();
  await expect(bar).toHaveCount(0);
  await page.keyboard.insertText("继续编辑");
  await expect(cell).toHaveText("继续编辑");
  await page.keyboard.press("Shift+F10");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-placement", "header");
  const b = (await bar.boundingBox())!,
    c = (await cell.boundingBox())!;
  expect(b.y + b.height <= c.y || b.y >= c.y + c.height).toBe(true);
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await page.keyboard.insertText("原单元格");
  await expect(cell).toContainText("原单元格");
});

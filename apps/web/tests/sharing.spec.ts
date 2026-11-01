import { test, expect } from "@playwright/test";
import { login, createLibrary, createNote } from "./helpers";
test("私有笔记生成只读外链、匿名阅读附件、撤销后清除公开正文", async ({
  page,
  browser,
}) => {
  await login(page);
  await createLibrary(page);
  await createNote(page);
  await page.getByLabel("笔记标题", { exact: true }).fill("外部只读验收");
  await page.getByLabel("笔记标题", { exact: true }).press("Tab");
  await page.getByTestId("editor").click();
  await page.keyboard.insertText("允许公开讲解的研究内容。");
  await page
    .getByLabel("上传附件文件", { exact: true })
    .setInputFiles("artifacts/server/fixtures/sample.png");
  await expect(page.locator(".media-resource")).toHaveCount(1);
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  await page.getByRole("button", { name: "共享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分享笔记" });
  await expect(dialog.getByLabel("可见范围", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "生成外链", exact: true }).click();
  const url = await dialog.getByLabel("外部链接", { exact: true }).inputValue();
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(url);
    await expect(
      guest.getByRole("heading", { name: "外部只读验收", exact: true }),
    ).toBeVisible();
    await expect(guest.getByTestId("editor")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await expect(guest.getByTestId("editor")).toContainText("允许公开讲解");
    await expect(guest.locator(".media-resource img")).toHaveJSProperty(
      "naturalWidth",
      64,
    );
    await dialog
      .getByRole("button", { name: "恢复仅自己可见", exact: true })
      .click();
    await expect(guest.getByTestId("editor")).toHaveCount(0, {
      timeout: 12000,
    });
    await expect(guest.getByRole("status")).toContainText("分享已失效");
  } finally {
    await context.close();
  }
});

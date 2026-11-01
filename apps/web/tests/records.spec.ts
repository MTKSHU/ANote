import { test, expect } from "@playwright/test";
import { login, createLibrary, createNote, typeBody } from "./helpers";
test("会议使用笔记阅读，顶部保留题目与三个主要入口", async ({ page }) => {
  await login(page);
  await createLibrary(page);
  await createNote(page, "本周组会 · 研究进展");
  await typeBody(page, "本周进展与下一步计划。");
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect(page.getByTestId("editor")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue(
    "本周组会 · 研究进展",
  );
  await expect(
    page
      .locator(".document-actions")
      .getByRole("button", { name: "评论", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".document-actions")
      .getByRole("button", { name: "历史版本", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".document-actions")
      .getByRole("button", { name: "共享", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".editor-toolbar,.note-topbar")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByTestId("editor")).toHaveAttribute(
    "contenteditable",
    "true",
  );
});

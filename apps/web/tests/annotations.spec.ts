import { test, expect } from "@playwright/test";
import {
  login,
  createLibrary,
  createNote,
  typeBody,
  selectText,
  api,
  admin,
} from "./helpers";

test("段落与选区旁批：虚线、错位防重叠、双向定位、回复及解决重开", async ({
  page,
  request,
}) => {
  await login(page);
  await createLibrary(page);
  const id = await createNote(page, "旁批与评论建议");
  await typeBody(page, "第一段：说明实验配置。");
  for (const text of ["相同结论：继续训练。", "相同结论：继续训练。"]) {
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(text);
  }
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  const account = await admin(request),
    before = await api(request, "GET", `documents/${id}`, undefined, account);
  const paragraphs = () =>
    page.getByTestId("editor").locator(":scope > p").filter({ hasText: /\S/ });
  await paragraphs().first().click();
  await page
    .getByRole("button", { name: "批注当前选区或段落", exact: true })
    .click();
  await expect(page.getByLabel("评论原文", { exact: true })).toContainText(
    "第一段",
  );
  await page.getByLabel("评论内容", { exact: true }).fill("请补充训练时长。");
  await page.getByRole("button", { name: "添加评论", exact: true }).click();
  const cards = page.locator(".annotation-card:not(.annotation-draft)");
  await expect(cards).toHaveCount(1);
  const firstId = (await cards.first().getAttribute("data-comment-id"))!;
  await expect(
    page.locator(`.annotation-connectors path[data-thread-id="${firstId}"]`),
  ).toBeVisible();
  const original = await paragraphs().first().boundingBox(),
    card = await cards.first().boundingBox();
  expect(Math.abs(card!.y - original!.y)).toBeLessThan(90);
  await selectText(page, ":scope > p", 2);
  await page
    .getByRole("toolbar", { name: "选区格式" })
    .getByRole("button", { name: "添加批注", exact: true })
    .click();
  await page
    .getByLabel("评论内容", { exact: true })
    .fill("这条意见只属于第三段。");
  await page.getByRole("button", { name: "添加评论", exact: true }).click();
  await expect(cards).toHaveCount(2);
  const second = cards.filter({ hasText: "这条意见只属于第三段。" }),
    secondId = (await second.getAttribute("data-comment-id"))!;
  await expect(paragraphs().nth(1).locator(".annotation-source")).toHaveCount(
    0,
  );
  await expect(
    paragraphs().nth(2).locator(`[data-comment-id="${secondId}"]`),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const a = (await cards.first().boundingBox())!,
        b = (await second.boundingBox())!;
      return b.y - (a.y + a.height);
    })
    .toBeGreaterThanOrEqual(10);
  await page.screenshot({
    path: "artifacts/web/academic-margin-comments.png",
    fullPage: true,
  });
  await second
    .getByLabel("回复 " + secondId, { exact: true })
    .fill("已记录，下一轮补上。");
  await second.getByRole("button", { name: "回复", exact: true }).click();
  await expect(second).toContainText("已记录，下一轮补上。");
  const after = await api(
    request,
    "GET",
    `documents/${id}`,
    undefined,
    account,
  );
  expect(after.hash).toBe(before.hash);
  await second.getByRole("button", { name: "解决评论", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await page.getByLabel("批注筛选", { exact: true }).selectOption("resolved");
  await expect(second).toBeVisible();
  await second.getByRole("button", { name: /查看讨论/ }).click();
  await second.getByRole("button", { name: "重新打开", exact: true }).click();
  await page.getByLabel("批注筛选", { exact: true }).selectOption("open");
  await expect(cards).toHaveCount(2);
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect(page.locator(".annotation-rail")).toHaveCount(0);
  await paragraphs()
    .last()
    .locator(`[data-comment-id="${secondId}"]`)
    .first()
    .click();
  await expect(second).toHaveClass(/active/);
  await expect(
    page.locator(`.annotation-source-active[data-comment-id="${secondId}"]`),
  ).toBeVisible();
  await page.setViewportSize({ width: 1180, height: 900 });
  await expect
    .poll(async () => {
      const a = (await cards.first().boundingBox())!,
        b = (await second.boundingBox())!;
      return b.y - (a.y + a.height);
    })
    .toBeGreaterThanOrEqual(10);
  await page.reload();
  await expect(page.getByTestId("editor")).toContainText("相同结论");
  await page
    .locator(".document-actions")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await expect(cards).toHaveCount(2);
  await expect(second).toContainText("已记录，下一轮补上。");
});

test("批注锚点跟随正文编辑；原文删除后保留卡片并取消虚线，草稿关闭侧栏仍保留", async ({
  page,
}) => {
  await login(page);
  await createLibrary(page);
  await createNote(page, "锚点追踪");
  await typeBody(page, "用于训练的目标段落。");
  await selectText(page);
  await page
    .getByRole("toolbar", { name: "选区格式" })
    .getByRole("button", { name: "添加批注", exact: true })
    .click();
  await page.getByLabel("评论内容", { exact: true }).fill("确认目标参数。");
  await page.getByRole("button", { name: "添加评论", exact: true }).click();
  const card = page.locator(".annotation-card:not(.annotation-draft)"),
    id = (await card.getAttribute("data-comment-id"))!;
  await page.getByTestId("editor").locator(":scope > p").first().click();
  await page.keyboard.press("Home");
  await page.keyboard.insertText("新增引言。");
  const source = page
    .locator(`.research-editor [data-comment-id="${id}"]`)
    .first();
  await expect(source).toHaveText("用于训练的目标段落。");
  await selectText(page, ":scope > p", 0);
  await page.keyboard.press("Backspace");
  await expect(card.locator("blockquote")).toHaveText("引用已失效，批注保留");
  await expect(
    page.locator(`.annotation-connectors path[data-thread-id="${id}"]`),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "定位原文", exact: true }),
  ).toBeDisabled();
  await page.getByTestId("editor").locator(":scope > p").first().click();
  await page.keyboard.insertText("重新记录参数。");
  await page.keyboard.press("Control+Alt+m");
  await expect(page.getByLabel("评论内容", { exact: true })).toBeVisible();
  await page
    .getByLabel("评论内容", { exact: true })
    .fill("尚未发送的评论建议。");
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page
    .locator(".document-actions")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await expect(page.getByLabel("评论内容", { exact: true })).toHaveValue(
    "尚未发送的评论建议。",
  );
  await page.getByRole("button", { name: "取消批注", exact: true }).click();
  await expect(page.getByLabel("评论内容", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 700, height: 850 });
  await expect(card).toBeVisible();
  await expect(page.locator(".annotation-connectors")).toBeHidden();
  await page.screenshot({
    path: "artifacts/web/academic-orphaned-comment.png",
    fullPage: true,
  });
});

test("中文组合输入期间收到新批注，不中断输入或重复写入文字", async ({
  page,
  request,
}) => {
  await login(page);
  await createLibrary(page);
  const id = await createNote(page, "中文输入与批注刷新");
  await typeBody(page, "原文保持不变。");
  await selectText(page);
  await page
    .getByRole("toolbar", { name: "选区格式" })
    .getByRole("button", { name: "添加批注", exact: true })
    .click();
  await page.getByLabel("评论内容", { exact: true }).fill("第一条建议");
  await page.getByRole("button", { name: "添加评论", exact: true }).click();
  await expect(
    page.locator(".annotation-card:not(.annotation-draft)"),
  ).toHaveCount(1);
  const account = await admin(request),
    comments = await api(
      request,
      "GET",
      `documents/${id}/comments`,
      undefined,
      account,
    );
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.getByTestId("editor").locator(":scope > p").first().click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+b");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "中",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await expect(
    page.getByTestId("editor").locator(":scope > p").last(),
  ).toHaveText("中");
  const refreshed = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/documents/${id}/comments` &&
      r.request().method() === "GET",
  );
  await api(
    request,
    "POST",
    `documents/${id}/comments`,
    { anchor: comments[0].anchor, text: "组合输入期间的新批注" },
    account,
  );
  await (await refreshed).finished();
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await cdp.send("Input.imeSetComposition", {
    text: "中文",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await cdp.send("Input.insertText", { text: "中文" });
  await expect(
    page.getByTestId("editor").locator(":scope > p").last(),
  ).toHaveText("中文");
  await expect(
    page.getByTestId("editor").locator(":scope > p").last().locator("strong"),
  ).toHaveText("中文");
  await page
    .locator(".document-actions")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await expect(
    page.locator(".annotation-card:not(.annotation-draft)"),
  ).toHaveCount(2);
  await expect(page.getByTestId("editor")).toContainText("原文保持不变。");
  await cdp.detach();
});

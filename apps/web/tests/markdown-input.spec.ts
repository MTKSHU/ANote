import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { api, admin, login, slash } from "./helpers";
async function setup(request: APIRequestContext) {
  const root = await admin(request),
    username = "markdown-" + randomUUID().slice(0, 8),
    password = "Markdown-input-test-123!";
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
    { name: "Markdown 效率", kind: "personal" },
    owner,
  );
  return { owner, book };
}
async function open(
  page: Page,
  request: APIRequestContext,
  owner: any,
  book: any,
  title: string,
) {
  const note = await api(
    request,
    "POST",
    "documents",
    { space_id: book.id, title },
    owner,
  );
  await page.goto("/?doc=" + note.id);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByTestId("editor").locator("p").first().click();
  return note;
}
async function paste(page: Page, text: string, html = "") {
  await page.getByTestId("editor").evaluate(
    (el, { text, html }) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      if (html) data.setData("text/html", html);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { text, html },
  );
}
test("Markdown 快捷输入：H1–H5、无序／有序列表、引用、代码和行内格式", async ({
  page,
  request,
}) => {
  const { owner, book } = await setup(request);
  await login(page, owner);
  for (let level = 1; level <= 5; level++) {
    await open(page, request, owner, book, "标题 " + level);
    await page.keyboard.type("#".repeat(level) + " ");
    await page.keyboard.insertText("标题内容");
    await expect(page.getByTestId("editor").locator("h" + level)).toHaveText(
      "标题内容",
    );
  }
  for (const [prefix, selector] of [
    ["- ", "ul li"],
    ["1. ", "ol li"],
    ["> ", "blockquote"],
  ]) {
    await open(page, request, owner, book, selector);
    await page.keyboard.type(prefix);
    await page.keyboard.insertText("研究内容");
    await expect(page.getByTestId("editor").locator(selector)).toHaveText(
      "研究内容",
    );
  }
  await open(page, request, owner, book, "代码块");
  await page.keyboard.type("```python");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("print('hello')");
  await expect(page.getByTestId("editor").locator("pre code")).toHaveText(
    "print('hello')",
  );
  await open(page, request, owner, book, "行内格式");
  await page.keyboard.type("**bold** *italic* ~~strike~~ `code`");
  for (const [selector, text] of [
    ["strong", "bold"],
    ["em", "italic"],
    ["s", "strike"],
    ["code", "code"],
  ])
    await expect(page.getByTestId("editor").locator(selector)).toHaveText(text);
  await page.reload();
  await expect(page.getByTestId("editor").locator("strong")).toHaveText("bold");
});
test("整行与中文组合输入的 Markdown 标题保留文字，代码和转义文本保留原样", async ({
  page,
  request,
}) => {
  const { owner, book } = await setup(request);
  await login(page, owner);
  await open(page, request, owner, book, "整行标题");
  await page.keyboard.insertText("## 你好");
  await expect(page.getByTestId("editor").locator("h2")).toHaveText("你好");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("后续正文");
  await expect(
    page
      .getByTestId("editor")
      .locator(":scope > p")
      .filter({ hasText: "后续正文" }),
  ).toHaveCount(1);
  await open(page, request, owner, book, "中文组合输入");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "## 中文组合标题",
    selectionStart: 9,
    selectionEnd: 9,
  });
  await cdp.send("Input.insertText", { text: "## 中文组合标题" });
  await expect(page.getByTestId("editor").locator("h2")).toHaveText(
    "中文组合标题",
  );
  await cdp.detach();
  await open(page, request, owner, book, "字面量");
  await page.keyboard.insertText("\\## 原样文字");
  await expect(page.getByTestId("editor").locator("h2")).toHaveCount(0);
  await open(page, request, owner, book, "代码原样");
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await paste(page, "## 原样代码\n**不是加粗**");
  await expect(page.getByTestId("editor").locator("pre code")).toContainText(
    "## 原样代码",
  );
  await expect(page.getByTestId("editor").locator("h2,strong")).toHaveCount(0);
});
test("粘贴常用 Markdown 并协作、重开与导出，原有增强表格保持不变", async ({
  page,
  request,
  browser,
}) => {
  const { owner, book } = await setup(request);
  await login(page, owner);
  const note = await open(page, request, owner, book, "粘贴 Markdown");
  await slash(page, "表格");
  await page.getByTestId("editor").locator("th").first().click();
  await page.keyboard.insertText("PSNR");
  const tableSnapshot = () =>
    page
      .getByTestId("editor")
      .evaluate((el) =>
        (el as any).editor
          .getJSON()
          .content.find((n: any) => n.type === "table"),
      );
  const beforeTable = await tableSnapshot();
  expect(beforeTable.attrs.blockId).toBeTruthy();
  await page.getByTestId("editor").locator(":scope > p").last().click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect
    .poll(() =>
      page
        .getByTestId("editor")
        .evaluate((el) => (el as any).editor.state.selection.$from.depth),
    )
    .toBe(1);
  const source =
    "## 你好\n\n**重点** 与 *说明*\n\n- 参数一\n- 参数二\n\n1. 第一步\n2. 第二步\n\n> 引用内容\n\n```python\nprint('hello')\n```";
  await paste(page, source);
  await expect(page.getByTestId("editor").locator("h2")).toHaveText("你好");
  await expect(page.getByTestId("editor").locator("strong")).toHaveText("重点");
  await expect(page.getByTestId("editor").locator("ul li")).toHaveCount(2);
  await expect(page.getByTestId("editor").locator("ol li")).toHaveCount(2);
  await expect(page.getByTestId("editor").locator("blockquote")).toHaveText(
    "引用内容",
  );
  expect(await tableSnapshot()).toEqual(beforeTable);
  const context = await browser.newContext();
  try {
    const peer = await context.newPage();
    await login(peer, owner);
    await peer.goto("/?doc=" + note.id);
    await expect(peer.getByTestId("editor").locator("h2")).toHaveText("你好");
    await expect(peer.getByTestId("editor").locator("th").first()).toHaveText(
      "PSNR",
    );
  } finally {
    await context.close();
  }
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
    .toContain("## 你好");
  await page.reload();
  await expect(page.getByTestId("editor").locator("h2")).toHaveText("你好");
  expect(await tableSnapshot()).toEqual(beforeTable);
  await page.screenshot({ path: "artifacts/web/markdown-paste.png" });
});
test("保留富文本剪贴板与明确的纯文本粘贴，粘贴内容不执行 HTML", async ({
  page,
  request,
}) => {
  const { owner, book } = await setup(request);
  await login(page, owner);
  await open(page, request, owner, book, "富文本剪贴板");
  await paste(page, "## 纯文本副本", "<p><em>富文本原格式</em></p>");
  await expect(page.getByTestId("editor").locator("em")).toHaveText(
    "富文本原格式",
  );
  await expect(page.getByTestId("editor").locator("h2")).toHaveCount(0);
  await open(page, request, owner, book, "明确纯文本");
  await page.keyboard.down("Shift");
  await paste(page, "## 原样标题");
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("editor")).toContainText("## 原样标题");
  await expect(page.getByTestId("editor").locator("h2")).toHaveCount(0);
  await open(page, request, owner, book, "HTML 字面量");
  await paste(
    page,
    "## 安全标题\n\n<script>window.markdownExecuted=true</script>\n\n![原图](https://example.test/image.png)",
  );
  await expect(page.getByTestId("editor")).toContainText("<script>");
  expect(
    await page.evaluate(() => (window as any).markdownExecuted),
  ).toBeUndefined();
  await expect(page.getByTestId("editor").locator("img")).toHaveCount(0);
  await expect(page.getByTestId("editor")).toContainText("![原图]");
});

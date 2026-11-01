import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { api as workspaceAPI } from "../../web/tests/helpers";
const origin = process.env.BASE_URL || "http://anote.internal:3000",
  applications: ElectronApplication[] = [];
async function api(
  request: APIRequestContext,
  method: string,
  url: string,
  data?: any,
  account?: any,
) {
  return workspaceAPI(request, method, url, data, account);
}
async function launch(id: string, account: any) {
  const directory = path.resolve(
    "artifacts/desktop/formal-profiles",
    randomUUID(),
  );
  await fs.mkdir(directory, { recursive: true });
  const application = await _electron.launch({
    args: ["--no-sandbox", "apps/desktop", "--document=" + id],
    env: {
      ...process.env,
      ANOTE_LOCALE: "zh-CN",
      ANOTE_CLIENT_DATA_DIR: directory,
      ANOTE_DESKTOP_TEST: "1",
    },
  });
  applications.push(application);
  const page = await application.firstWindow();
  await page.getByRole("button", { name: "连接团队空间", exact: true }).click();
  await page.getByLabel("服务地址").fill(origin);
  await page.getByLabel("用户名", { exact: true }).fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "连接研究空间 →" }).click();
  await page.waitForFunction(() => !!window.__anoteTest?.editor);
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  return { application, page, directory };
}
test.afterEach(async () => {
  for (const application of applications)
    await application.close().catch(() => {});
  applications.length = 0;
});
test("Electron 正式服务：真实账号、受管文件、评论线程、阅读权限与凭据缓存隔离", async ({
  request,
}) => {
  const admin = await api(request, "POST", "auth/login", {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    }),
    space = (
      await api(
        request,
        "POST",
        "spaces",
        { name: "客户端集成 " + randomUUID().slice(0, 5) },
        admin,
      )
    ).id,
    accounts: any = {};
  for (const role of ["editor", "reviewer", "viewer"]) {
    const username = "native-" + role + "-" + randomUUID().slice(0, 7),
      password = randomBytes(18).toString("hex"),
      user = await api(
        request,
        "POST",
        "users",
        { username, password, name: "桌面成员 " + role },
        admin,
      );
    const account = await api(request, "POST", "auth/login", {
      username,
      password,
    });
    accounts[role] = { ...account, username, password };
    await api(
      request,
      "POST",
      `spaces/${space}/members`,
      { user_id: user.id, role },
      admin,
    );
  }
  const created = await api(
      request,
      "POST",
      "documents",
      { space_id: space, title: "正式客户端研究记录", visibility: "team" },
      accounts.editor,
    ),
    id = created.id,
    client = await launch(id, accounts.editor);
  await client.page
    .getByLabel("笔记标题", { exact: true })
    .fill("正式客户端研究记录 · 已编辑");
  await client.page.getByLabel("笔记标题", { exact: true }).press("Tab");
  await expect
    .poll(
      async () =>
        (
          await api(
            request,
            "GET",
            `documents/${id}`,
            undefined,
            accounts.editor,
          )
        ).title,
    )
    .toBe("正式客户端研究记录 · 已编辑");
  await client.page.getByTestId("editor").locator(":scope > p").last().click();
  await client.page.keyboard.insertText("用于场景重建的实验记录。");
  await client.page
    .getByTestId("editor")
    .locator(":scope > p")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  const formats = client.page.getByRole("toolbar", { name: "选区格式" });
  await formats.getByRole("button", { name: "字号", exact: true }).click();
  await client.page.getByRole("button", { name: "20 px", exact: true }).click();
  await formats.getByRole("button", { name: "文字颜色", exact: true }).click();
  await client.page
    .getByRole("button", { name: "文字色 蓝色", exact: true })
    .click();
  await formats.getByRole("button", { name: "背景颜色", exact: true }).click();
  await client.page
    .getByRole("button", { name: "背景色 黄色", exact: true })
    .click();
  await client.page.getByTestId("editor").locator(":scope > p").first().click();
  await client.page.keyboard.press("ArrowRight");
  await expect(client.page.getByTestId("document-sync")).toHaveText("已同步");
  await client.page
    .getByLabel("上传附件文件", { exact: true })
    .setInputFiles(
      ["sample.png", "wide.png", "tall.png"].map(
        (v) => "artifacts/server/fixtures/" + v,
      ),
    );
  await expect(client.page.locator(".media-resource")).toHaveCount(3);
  await client.page.getByTestId("editor").locator(":scope > p").last().click();
  await client.page.keyboard.press("End");
  await client.page.keyboard.insertText("/多图对比");
  await client.page
    .getByRole("listbox", { name: "插入内容" })
    .getByRole("option", { name: /多图对比/ })
    .click();
  await client.page
    .getByLabel("上传附件文件", { exact: true })
    .setInputFiles(
      ["sample.png", "wide.png", "tall.png"].map(
        (v) => "artifacts/server/fixtures/" + v,
      ),
    );
  await expect(client.page.locator(".comparison-grid-cell")).toHaveCount(3);
  await expect
    .poll(() =>
      client.page
        .locator(".comparison-grid-cell img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  await expect(client.page.getByTestId("document-sync")).toHaveText("已同步");
  await expect(
    client.page.getByTestId("editor").locator(":scope > p").first(),
  ).toContainText("用于场景重建的实验记录。");
  const tail = client.page.getByTestId("editor").locator(":scope > p").last();
  await expect(tail).toHaveText("");
  await tail.click();
  await client.page.keyboard.press("ArrowRight");
  await expect(
    client.page.getByRole("toolbar", { name: "选区格式" }),
  ).toHaveCount(0);
  await client.page.keyboard.press("End");
  await client.page.keyboard.insertText("/表格");
  await client.page
    .getByRole("listbox", { name: "插入内容" })
    .getByRole("option", { name: /^表格/ })
    .click();
  const table = client.page.getByTestId("editor").locator("table");
  await table.locator("td").first().click();
  await client.page.keyboard.insertText("客户端表格");
  await expect(
    client.page.getByRole("toolbar", { name: "表格操作" }),
  ).toHaveCount(0);
  await table.hover();
  await client.page
    .getByRole("button", { name: "选择第 2 行", exact: true })
    .click();
  await client.page
    .getByRole("toolbar", { name: "表格操作" })
    .getByRole("button", { name: "在下方插入行", exact: true })
    .click();
  await expect(table.locator("tr")).toHaveCount(4);
  await client.page.keyboard.press("Escape");
  await expect(
    client.page.getByRole("toolbar", { name: "表格操作" }),
  ).toHaveCount(0);
  await expect(
    client.page.getByTestId("editor").locator(":scope > p").first(),
  ).toContainText("用于场景重建的实验记录。");
  const workspace = path.resolve(
    "artifacts/desktop/formal-workspaces",
    randomUUID(),
  );
  await fs.mkdir(workspace, { recursive: true });
  await client.application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, workspace);
  await client.page.getByRole("button", { name: "本地工作目录" }).click();
  await client.page.locator(".note-more>summary").click();
  await client.page
    .getByRole("button", { name: "本地同步", exact: true })
    .click();
  await client.page.getByRole("button", { name: "↓ 下载到本地目录" }).click();
  const file = path.join(workspace, id, "研究笔记.md");
  await expect
    .poll(() => fs.readFile(file, "utf8").catch(() => ""))
    .toContain("用于场景重建的实验记录。");
  const base = JSON.parse(
    await fs.readFile(
      path.join(workspace, id, ".anote", id + ".base.json"),
      "utf8",
    ),
  );
  expect(base.assets).toHaveLength(6);
  for (const attachment of base.assets) {
    const bytes = await fs.readFile(path.join(workspace, id, attachment.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      attachment.hash,
    );
  }
  await client.page.evaluate(() => window.anote.offline(true));
  await client.page.locator(".comparison-grid-cell img").evaluateAll((images) =>
    images.forEach((image) => {
      const img = image as HTMLImageElement;
      img.src = img.src + "?offline-proof=1";
    }),
  );
  await expect
    .poll(() =>
      client.page
        .locator(".comparison-grid-cell img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  const localResponse = await client.page.evaluate(
    (assetId: string) =>
      fetch(`/api/assets/${assetId}/file`, {
        headers: { Range: "bytes=0-7" },
      }).then(async (res) => ({
        status: res.status,
        cache: res.headers.get("X-ANote-Cache"),
        bytes: (await res.arrayBuffer()).byteLength,
      })),
    base.assets[0].id,
  );
  expect(localResponse).toEqual({ status: 206, cache: "local-sync", bytes: 8 });
  await client.page.evaluate(() => window.anote.offline(false));
  await fs.writeFile(
    file,
    (await fs.readFile(file, "utf8")).replace(
      "用于场景重建的实验记录。",
      "用于场景重建的实验记录。本地 Markdown 已回传。",
    ),
  );
  await expect(client.page.getByTestId("editor")).toContainText(
    "本地 Markdown 已回传。",
  );

  const styledText = client.page
    .getByTestId("editor")
    .locator("span[style]")
    .filter({ hasText: "本地 Markdown 已回传。" });
  await expect(styledText).toHaveCSS("color", "rgb(37, 99, 235)");
  await expect(styledText).toHaveCSS("font-size", "20px");
  await expect(styledText).toHaveCSS("background-color", "rgb(254, 240, 138)");
  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table).toContainText("客户端表格");
  const state = await client.page.evaluate(() => window.anote.state());
  const auth = await client.page.evaluate(() =>
    fetch("/api/auth/session").then((response) => response.json()),
  );
  expect(auth.token === state.token).toBe(true);
  const cache = path.join(client.directory, "http-cache"),
    bodies = await Promise.all(
      (await fs.readdir(cache))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const value = JSON.parse(
            await fs.readFile(path.join(cache, name), "utf8"),
          );
          return Buffer.from(value.body, "base64").toString("utf8");
        }),
    );
  expect(bodies.some((body) => body.includes(state.token!))).toBe(false);
  expect(
    (
      await fs.readFile(path.join(client.directory, "settings.json"), "utf8")
    ).includes(state.token!),
  ).toBe(false);
  await client.page
    .locator(".document-actions")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await client.page
    .getByTestId("editor")
    .locator(":scope > p")
    .filter({ hasText: "场景重建" })
    .first()
    .click();
  await client.page
    .getByRole("button", { name: "批注当前选区或段落", exact: true })
    .click();
  await client.page.getByLabel("评论内容").fill("请核对这一轮配置。");
  await client.page
    .getByRole("button", { name: "添加评论", exact: true })
    .click();
  await expect(client.page.locator(".inspector-content")).toContainText(
    "请核对这一轮配置。",
  );
  const reviewer = await launch(id, accounts.reviewer);
  await expect(reviewer.page.getByTestId("editor")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await reviewer.page
    .locator(".document-actions")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await reviewer.page
    .getByRole("button", { name: /查看讨论/ })
    .first()
    .click();
  await reviewer.page.getByPlaceholder("回复这条批注…").fill("配置已核对。");
  await reviewer.page
    .getByRole("button", { name: "回复", exact: true })
    .click();
  await expect(client.page.locator(".inspector-content")).toContainText(
    "配置已核对。",
  );
  await reviewer.page
    .getByRole("button", { name: "解决评论", exact: true })
    .click();
  await expect(
    client.page.locator(".annotation-card:not(.annotation-draft)"),
  ).toHaveCount(0);
  await client.page
    .getByLabel("批注筛选", { exact: true })
    .selectOption("resolved");
  await expect(client.page.locator(".annotation-card")).toContainText(
    "配置已核对。",
  );
  const reader = await launch(id, accounts.viewer);
  await expect(reader.page.getByTestId("editor")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await reader.page.locator(".note-more>summary").click();
  await reader.page
    .getByRole("button", { name: "本地同步", exact: true })
    .click();
  await expect(
    reader.page.getByRole("button", { name: "↓ 下载到本地目录" }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      client.page
        .locator(".comparison-grid-cell img")
        .evaluateAll((images) =>
          images.map((img) => [
            (img as HTMLImageElement).naturalWidth,
            (img as HTMLImageElement).naturalHeight,
          ]),
        ),
    )
    .toEqual([
      [64, 64],
      [96, 48],
      [48, 96],
    ]);
  await client.page.getByText("管理图片与说明", { exact: true }).click();
  const settings = client.page.locator(".comparison-settings");
  await settings.getByLabel("图片说明 3", { exact: true }).fill("高斯重建");
  await settings
    .getByRole("button", { name: "上移", exact: true })
    .nth(2)
    .click();
  await expect(
    client.page.locator(".comparison-grid-cell span").nth(1),
  ).toHaveText("高斯重建");
  await settings
    .getByRole("button", { name: "移除", exact: true })
    .first()
    .click();
  await expect(client.page.locator(".comparison-grid-cell")).toHaveCount(2);
  await client.page
    .getByRole("button", { name: "滑动对比", exact: true })
    .click();
  await expect(client.page.locator(".comparison-canvas img")).toHaveCount(2);
  await client.page.screenshot({
    path: "artifacts/desktop/formal-workspace.png",
    fullPage: true,
  });
});

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
import { randomUUID } from "node:crypto";

const origin =
  process.env.BASE_URL || "http://anote-validation.internal:3000";
const secret = process.env.VALIDATION_SECRET!;
const root = path.resolve("artifacts/desktop");
let applications: ElectronApplication[] = [];
test.afterEach(async () => {
  for (const application of applications)
    await application.close().catch(() => {});
  applications = [];
});
async function session(request: APIRequestContext, user = "alice") {
  const response = await request.post("/api/session", {
    data: { user, secret },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function document(request: APIRequestContext) {
  const account = await session(request);
  const response = await request.post("/api/documents", {
    headers: { Authorization: "Bearer " + account.token },
    data: { title: "桌面验证 · " + randomUUID().slice(0, 6) },
  });
  expect(response.ok()).toBeTruthy();
  return { ...(await response.json()), account };
}
async function launch(
  id: string,
  dataDir = path.join(root, "profiles", randomUUID()),
) {
  await fs.mkdir(dataDir, { recursive: true });
  const application = await _electron.launch({
    args: ["--no-sandbox", "apps/desktop", "--document=" + id],
    env: {
      ...process.env,
      ANOTE_LOCALE: "zh-CN",
      ANOTE_CLIENT_DATA_DIR: dataDir,
      ANOTE_DESKTOP_TEST: "1",
    },
    timeout: 30000,
  });
  applications.push(application);
  const page = await application.firstWindow();
  page.on("pageerror", (error) => console.error("Renderer:", error.message));
  await page.waitForLoadState("domcontentloaded");
  await expect(page).toHaveURL(new RegExp(id));
  return { application, page, dataDir };
}
async function login(page: Page, user = "alice") {
  await page.getByRole("button", { name: "连接团队空间", exact: true }).click();
  await page.getByLabel("服务地址", { exact: true }).fill(origin);
  await page.getByLabel("用户名", { exact: true }).fill(user);
  await page.getByLabel("密码", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "连接研究空间 →" }).click();
  await page.waitForFunction(() => !!window.__anoteTest?.editor);
  await page.locator(".note-more>summary").click();
  await page.getByRole("button", { name: "本地同步", exact: true }).click();
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
}
async function snapshot(page: Page) {
  return page.evaluate(() => window.__anoteTest.editor.getJSON());
}
async function append(page: Page, id: string, text: string) {
  await page.evaluate(
    ({ id, text }) => {
      const editor = window.__anoteTest.editor;
      let position = -1;
      editor.state.doc.forEach((node: any, offset: number) => {
        if (node.attrs.blockId === id) position = offset + node.nodeSize - 1;
      });
      if (position < 0) throw new Error("找不到段落");
      editor.commands.insertContentAt(position, text);
    },
    { id, text },
  );
}
const block = (doc: any, id: string) =>
  doc.content.find((n: any) => n.attrs?.blockId === id);
async function waitRemote(
  request: APIRequestContext,
  account: any,
  id: string,
  text: string,
) {
  await expect
    .poll(async () => {
      const result = await request.get("/api/documents/" + id, {
        headers: { Authorization: "Bearer " + account.token },
      });
      return JSON.stringify((await result.json()).snapshot);
    })
    .toContain(text);
}
async function choose(
  application: ElectronApplication,
  page: Page,
  directory: string,
) {
  await fs.mkdir(directory, { recursive: true });
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, directory);
  await page.getByRole("button", { name: "本地工作目录" }).click();
}

test("真实 Electron：受限桥接、双客户端协作与增强节点保真", async ({
  request,
}) => {
  const { id } = await document(request),
    a = await launch(id),
    b = await launch(id);
  await login(a.page);
  await login(b.page, "bob");
  const preferences = await a.application.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
    };
  });
  expect(preferences).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  expect(
    await a.page.evaluate(() => ({
      require: typeof (window as any).require,
      process: typeof (window as any).process,
      api: Object.keys(window.anote).sort(),
    })),
  ).toEqual({
    require: "undefined",
    process: "undefined",
    api: [
      "acceptRemote",
      "cancelCasdoor",
      "casdoorProviders",
      "checkout",
      "chooseWorkspace",
      "connect",
      "connectCasdoor",
      "enterPersonal",
      "leavePersonal",
      "logout",
      "offline",
      "onBeforeClose",
      "onState",
      "openPersonalFolder",
      "selectDocument",
      "state",
      "sync",
    ],
  });
  const before = await snapshot(a.page);
  await Promise.all([
    append(a.page, "intro", " 桌面 Alice 并发记录。"),
    append(b.page, "next", " 桌面 Bob 并发记录。"),
  ]);
  await expect(a.page.getByTestId("editor")).toContainText(
    "桌面 Bob 并发记录。",
  );
  await expect(b.page.getByTestId("editor")).toContainText(
    "桌面 Alice 并发记录。",
  );
  await expect
    .poll(
      async () =>
        JSON.stringify(await snapshot(a.page)) ===
        JSON.stringify(await snapshot(b.page)),
    )
    .toBe(true);
  const after = await snapshot(a.page);
  expect(block(after, "quality-table")).toEqual(block(before, "quality-table"));
  expect(block(after, "comparison")).toEqual(block(before, "comparison"));
  await a.page.evaluate(() => {
    const editor = window.__anoteTest.editor,
      node = editor
        .getJSON()
        .content.find((node: any) => node.attrs?.blockId === "intro");
    editor.commands.insertContentAt(
      editor.state.doc.content.size,
      structuredClone(node),
    );
  });
  await expect
    .poll(async () => {
      const doc = await snapshot(a.page),
        ids = doc.content.map((node: any) => node.attrs.blockId);
      return new Set(ids).size === ids.length;
    })
    .toBe(true);
  await expect
    .poll(
      async () =>
        JSON.stringify(await snapshot(a.page)) ===
        JSON.stringify(await snapshot(b.page)),
    )
    .toBe(true);
  await a.page.screenshot({
    path: path.join(root, "desktop-online.png"),
    fullPage: true,
  });
});

test("离线富文本与附件缓存：关闭并重启真实客户端后恢复，再与服务器合并", async ({
  request,
}) => {
  const { id, account } = await document(request);
  let client = await launch(id);
  await login(client.page);
  await expect(
    client.page.getByTestId("image-comparison").locator("img").first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      client.page
        .getByTestId("image-comparison")
        .locator("img")
        .first()
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await client.page.getByRole("button", { name: "在线同步" }).click();
  await expect(client.page.getByTestId("document-sync")).toHaveText("离线编辑");
  await append(client.page, "conclusion", " 断网期间的研究结果。");
  const before = await snapshot(client.page);
  await client.application.close();
  applications = applications.filter((app) => app !== client.application);
  client = await launch(id, client.dataDir);
  await client.page.waitForFunction(() => !!window.__anoteTest?.editor);
  await expect(client.page.getByTestId("editor")).toContainText(
    "断网期间的研究结果。",
  );
  expect(await snapshot(client.page)).toEqual(before);
  await expect
    .poll(() =>
      client.page
        .getByTestId("image-comparison")
        .locator("img")
        .first()
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await client.page.screenshot({
    path: path.join(root, "desktop-offline-restored.png"),
    fullPage: true,
  });
  // The container has no operating-system keyring: reauthenticate through the same native IPC.
  await client.page.evaluate(
    ({ serverURL, password }) =>
      window.anote.connect({ serverURL, username: "alice", password }),
    { serverURL: origin, password: secret },
  );
  await expect(client.page.getByTestId("document-sync")).toHaveText("已同步");
  await waitRemote(request, account, id, "断网期间的研究结果。");
});

test("原生目录：文件监听、重命名、离线队列重启、冲突副本和账号隔离", async ({
  request,
}) => {
  const { id, account, title } = await document(request);
  let client = await launch(id);
  await login(client.page);
  const directory = path.join(root, "workspaces", randomUUID());
  await choose(client.application, client.page, directory);
  await client.page.getByRole("button", { name: "↓ 下载到本地目录" }).click();
  const localDir = path.join(directory, id),
    original = path.join(localDir, "研究笔记.md"),
    renamed = path.join(localDir, "本地研究笔记.md");
  await expect
    .poll(() => fs.readFile(original, "utf8").catch(() => null))
    .not.toBeNull();
  await fs.rename(original, renamed);
  const before = await snapshot(client.page);
  await fs.writeFile(
    renamed,
    (await fs.readFile(renamed, "utf8")).replace(
      "用于记录场景重建。",
      "用于记录场景重建。原生目录自动同步。",
    ),
  );
  await expect(client.page.getByTestId("editor")).toContainText(
    "原生目录自动同步。",
  );
  await waitRemote(request, account, id, "原生目录自动同步。");
  expect(block(await snapshot(client.page), "quality-table")).toEqual(
    block(before, "quality-table"),
  );
  await client.page.getByRole("button", { name: "在线同步" }).click();
  await fs.writeFile(
    renamed,
    (await fs.readFile(renamed, "utf8")).replace(
      "结论：继续补充实验。",
      "结论：离线文件修改排队。",
    ),
  );
  await expect(client.page.getByTestId("local-job")).toContainText("等待同步");
  await client.application.close();
  applications = applications.filter((app) => app !== client.application);
  client = await launch(id, client.dataDir);
  await client.page.waitForFunction(() => !!window.__anoteTest?.editor);
  await client.page.locator(".note-more>summary").click();
  await client.page
    .getByRole("button", { name: "本地同步", exact: true })
    .click();
  await expect(client.page.getByTestId("local-job")).toContainText("等待同步");
  await client.page.evaluate(
    ({ serverURL, password }) =>
      window.anote.connect({ serverURL, username: "alice", password }),
    { serverURL: origin, password: secret },
  );
  await waitRemote(request, account, id, "离线文件修改排队。");
  if (
    !(await client.page
      .getByRole("button", { name: "立即同步", exact: true })
      .count())
  )
    await client.page.locator(".note-more>summary").click();
  await client.page
    .getByRole("button", { name: "本地同步", exact: true })
    .click();
  // Keep a stale Markdown base, then introduce overlapping remote and local edits.
  await client.page
    .getByRole("button", { name: "立即同步", exact: true })
    .click();
  await client.page.getByRole("button", { name: "在线同步" }).click();
  const stale = await fs.readFile(renamed, "utf8");
  const exported = await request.get(`/api/documents/${id}/export`, {
    headers: { Authorization: "Bearer " + account.token },
  });
  const base = await exported.json();
  const remote = await request.post(`/api/documents/${id}/import`, {
    headers: { Authorization: "Bearer " + account.token },
    data: {
      opId: randomUUID(),
      markdown: base.markdown.replace(
        "用于记录场景重建。",
        "用于记录在线 Mesh 重建。",
      ),
    },
  });
  expect(remote.ok()).toBeTruthy();
  const local = stale.replace("用于记录场景重建。", "用于记录本地 NeRF 重建。");
  await fs.writeFile(renamed, local);
  await client.page.getByRole("button", { name: "离线模式" }).click();
  await expect(client.page.getByTestId("local-job")).toContainText(
    "需要处理冲突",
  );
  expect(await fs.readFile(renamed, "utf8")).toBe(local);
  expect(
    (await fs.readdir(path.join(localDir, ".anote/conflicts"))).length,
  ).toBeGreaterThan(0);
  await client.page.screenshot({
    path: path.join(root, "desktop-conflict.png"),
    fullPage: true,
  });
  const aliceState = await client.page.evaluate(() => window.anote.state());
  await client.page.evaluate(
    ({ serverURL, password }) =>
      window.anote.connect({ serverURL, username: "bob", password }),
    { serverURL: origin, password: secret },
  );
  const bobState = await client.page.evaluate(() => window.anote.state());
  expect(bobState.workspace).toBe("");
  expect(bobState.sync.documents).toEqual([]);
  expect(bobState.sync.pending).toEqual([]);
  await client.application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, directory);
  await expect(
    client.page.evaluate(() => window.anote.chooseWorkspace()),
  ).rejects.toThrow("另一个账号");
  await client.page.evaluate(
    ({ serverURL, password }) =>
      window.anote.connect({ serverURL, username: "alice", password }),
    { serverURL: origin, password: secret },
  );
  const restored = await client.page.evaluate(() => window.anote.state());
  expect(restored.workspace).toBe(aliceState.workspace);
  expect(restored.sync.pending.find((j) => j.docId === id)?.blocked).toBe(true);
  await client.page.getByRole("button", { name: new RegExp(title) }).click();
  await client.page.locator(".note-more>summary").click();
  await client.page
    .getByRole("button", { name: "本地同步", exact: true })
    .click();
  await expect(client.page.getByText("查看基准、线上与本地内容")).toBeVisible();
  await client.page
    .getByRole("button", { name: "保留本地副本，采用线上版本" })
    .click();
  await expect(client.page.getByTestId("local-job")).toHaveCount(0);
  expect(await fs.readFile(renamed, "utf8")).toContain(
    "用于记录在线 Mesh 重建。",
  );
  const retained = (
    await fs.readdir(path.join(localDir, ".anote/conflicts"))
  ).find((n) => n.startsWith("retained-") && n.endsWith(".md"))!;
  expect(
    await fs.readFile(
      path.join(localDir, ".anote/conflicts", retained),
      "utf8",
    ),
  ).toBe(local);
});

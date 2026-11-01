import {
  test,
  expect,
  type Page,
  type Browser,
  type BrowserContext,
  type APIRequestContext,
} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile),
  baseURL = process.env.BASE_URL || "http://127.0.0.1:3099",
  secret = process.env.VALIDATION_SECRET!;
let contexts: BrowserContext[] = [];
async function login(request: APIRequestContext, user = "alice") {
  const response = await request.post("/api/session", {
    data: { secret, user },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
const headers = (session: any) => ({
  Authorization: `Bearer ${session.token}`,
});
async function createDoc(request: APIRequestContext, session: any) {
  const response = await request.post("/api/documents", {
    headers: headers(session),
    data: { title: "关键链路验证 · " + randomUUID().slice(0, 6) },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function open(browser: Browser, session: any, id: string) {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1200 },
  });
  contexts.push(context);
  await context.addInitScript(
    (s) => localStorage.setItem("anote-session", JSON.stringify(s)),
    session,
  );
  const page = await context.newPage();
  await page.goto(`/?doc=${id}`);
  await page.waitForFunction(() => !!(window as any).__lab?.editor);
  await expect(page.getByTestId("connection")).toContainText("实时连接");
  return page;
}
async function snapshot(page: Page) {
  return page.evaluate(() => (window as any).__lab.getJSON());
}
async function append(page: Page, id: string, text: string) {
  await page.evaluate(
    ({ id, text }) => {
      const e = (window as any).__lab.editor;
      let pos = -1;
      e.state.doc.forEach((node: any, offset: number) => {
        if (node.attrs.blockId === id) pos = offset + node.nodeSize - 1;
      });
      if (pos < 0) throw new Error("Missing block " + id);
      e.commands.insertContentAt(pos, text);
    },
    { id, text },
  );
}
async function replaceBlock(page: Page, id: string, text: string) {
  await page.evaluate(
    ({ id, text }) => {
      const e = (window as any).__lab.editor;
      let found = false;
      e.state.doc.forEach((node: any, offset: number) => {
        if (node.attrs.blockId === id) {
          e.commands.insertContentAt(
            { from: offset + 1, to: offset + node.nodeSize - 1 },
            text,
          );
          found = true;
        }
      });
      if (!found) throw new Error("Missing block");
    },
    { id, text },
  );
}
async function setRange(page: Page, value: number) {
  const range = page.getByLabel("对比位置");
  await range.focus();
  await range.press("Home");
  for (let i = 0; i < Math.floor(value / 10); i++) await range.press("PageUp");
  for (let i = 0; i < value % 10; i++) await range.press("ArrowRight");
}
async function converge(a: Page, b: Page) {
  await expect
    .poll(
      async () =>
        JSON.stringify(await snapshot(a)) === JSON.stringify(await snapshot(b)),
    )
    .toBe(true);
}
async function getDoc(request: APIRequestContext, s: any, id: string) {
  const response = await request.get(`/api/documents/${id}`, {
    headers: headers(s),
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function exported(request: APIRequestContext, s: any, id: string) {
  const r = await request.get(`/api/documents/${id}/export`, {
    headers: headers(s),
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
async function cli(s: any, id: string, dir: string, command = "sync") {
  return exec(
    process.execPath,
    [
      "validation/scripts/sync-folder.mjs",
      command,
      "--url",
      baseURL,
      "--doc",
      id,
      "--dir",
      dir,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ANOTE_TOKEN: s.token },
      timeout: 20000,
    },
  );
}
const block = (doc: any, id: string) =>
  doc.content.find((n: any) => n.attrs?.blockId === id);
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

test("两个独立浏览器实时协作：段落、增强表格和多图参数收敛", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    bob = await login(request, "bob"),
    { id } = await createDoc(request, alice),
    a = await open(browser, alice, id),
    b = await open(browser, bob, id);
  await expect
    .poll(async () => a.getByTestId("member-count").innerText())
    .toContain("2");
  const intro = a.locator('[data-block-id="intro"]');
  await intro.click();
  await a.keyboard.press("End");
  await a.keyboard.insertText(" 浏览器键盘输入。");
  await expect(b.getByTestId("editor")).toContainText("浏览器键盘输入。");
  await Promise.all([
    append(a, "conclusion", " Alice 的结果。"),
    append(b, "conclusion", " Bob 的结果。"),
  ]);
  await converge(a, b);
  expect(JSON.stringify(await snapshot(a))).toContain("Alice 的结果。");
  expect(JSON.stringify(await snapshot(a))).toContain("Bob 的结果。");
  await a.evaluate(() => {
    const e = (window as any).__lab.editor;
    let pos = 0;
    e.state.doc.forEach((n: any, p: number) => {
      if (n.type.name === "table") pos = p;
    });
    e.commands.setTextSelection(pos + 4);
    if (!e.commands.splitCell()) throw new Error("split failed");
  });
  await converge(a, b);
  expect(
    block(await snapshot(a), "quality-table").content[0].content,
  ).toHaveLength(2);
  await a.evaluate(() => {
    const e = (window as any).__lab.editor;
    let pos = 0,
      first = 0;
    e.state.doc.forEach((n: any, p: number) => {
      if (n.type.name === "table") {
        pos = p;
        first = n.child(0).child(0).nodeSize;
      }
    });
    e.commands.setCellSelection({
      anchorCell: pos + 2,
      headCell: pos + 2 + first,
    });
    if (!e.commands.mergeCells()) throw new Error("merge failed");
  });
  await converge(a, b);
  expect(
    block(await snapshot(b), "quality-table").content[0].content[0].attrs
      .colspan,
  ).toBe(2);
  await setRange(a, 72);
  await a.getByRole("button", { name: "放大 ＋" }).click();
  await a.getByRole("button", { name: "平移 →" }).click();
  await converge(a, b);
  const comparison = block(await snapshot(b), "comparison");
  expect(comparison.attrs.slider).toBe(72);
  expect(comparison.attrs.zoom).toBe(1.25);
  expect(comparison.attrs.panX).toBe(15);
  await a.screenshot({
    path: "validation/artifacts/collaboration.png",
    fullPage: true,
  });
});

test("断线期间两端独立编辑，重连后收敛且增强节点保留", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    bob = await login(request, "bob"),
    { id } = await createDoc(request, alice),
    a = await open(browser, alice, id),
    b = await open(browser, bob, id),
    before = await snapshot(a);
  await a.evaluate(() => (window as any).__lab.provider.disconnect());
  await expect(a.getByTestId("connection")).not.toContainText("实时连接");
  await append(a, "intro", " 离线补充。");
  await append(b, "next", " 线上补充。");
  expect(JSON.stringify(await snapshot(b))).not.toContain("离线补充。");
  await a.evaluate(() => (window as any).__lab.provider.connect());
  await expect(a.getByTestId("connection")).toContainText("实时连接");
  await converge(a, b);
  expect(JSON.stringify(await snapshot(a))).toContain("离线补充。");
  expect(JSON.stringify(await snapshot(a))).toContain("线上补充。");
  expect(block(await snapshot(a), "quality-table")).toEqual(
    block(before, "quality-table"),
  );
  expect(block(await snapshot(a), "comparison")).toEqual(
    block(before, "comparison"),
  );
});

test("本地文件双向合并：保留增强内容、评论锚点、审核快照并识别重命名", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    bob = await login(request, "bob"),
    carol = await login(request, "carol"),
    { id } = await createDoc(request, alice),
    a = await open(browser, alice, id),
    b = await open(browser, bob, id);
  const anchor = await a.evaluate(() =>
    (window as any).__lab.findAnchor("场景重建"),
  );
  const c = await request.post(`/api/documents/${id}/comments`, {
    headers: headers(alice),
    data: { text: "请补充训练配置。", anchor, author: "forged-admin" },
  });
  expect(c.ok()).toBeTruthy();
  expect((await c.json()).author).toBe("alice");
  const submitted = await request.post(`/api/documents/${id}/reviews`, {
    headers: headers(alice),
    data: {},
  });
  const review = await submitted.json(),
    before = await snapshot(a),
    dir = path.resolve("validation/artifacts/local-notes", id);
  await cli(alice, id, dir, "pull");
  const original = path.join(dir, "研究笔记.md"),
    renamed = path.join(dir, "重命名后的研究笔记.md");
  await fs.rename(original, renamed);
  let md = await fs.readFile(renamed, "utf8");
  md = md
    .replace("用于记录场景重建。", "本地补充：用于记录场景重建。")
    .replace("结论：继续补充实验。", "结论：**本地实验记录已更新**。");
  await fs.writeFile(renamed, md);
  await append(b, "next", " 网页记录：seed=42。");
  await setRange(b, 67);
  await converge(a, b);
  const enhanced = await snapshot(b);
  const result = await cli(alice, id, dir, "push");
  expect(result.stdout).toContain("push");
  await expect(a.getByTestId("editor")).toContainText("本地补充：");
  await expect(b.getByTestId("editor")).toContainText("本地实验记录已更新");
  await converge(a, b);
  const after = await snapshot(a);
  expect(block(after, "quality-table")).toEqual(
    block(enhanced, "quality-table"),
  );
  expect(block(after, "comparison")).toEqual(block(enhanced, "comparison"));
  expect(
    block(after, "conclusion").content.some((n: any) =>
      n.marks?.some((m: any) => m.type === "bold"),
    ),
  ).toBe(true);
  const local = await fs.readFile(renamed, "utf8");
  expect(local).toContain("网页记录：seed=42。");
  expect(local).toContain("本地补充：");
  expect(
    await fs.readFile(path.join(dir, "assets/before.svg"), "utf8"),
  ).toContain("<svg");
  const comments = await (
    await request.get(`/api/documents/${id}/comments`, {
      headers: headers(alice),
    })
  ).json();
  expect(comments[0].resolvedAnchor).toMatchObject({
    orphaned: false,
    text: "场景重建",
  });
  const approved = await request.post(
    `/api/documents/${id}/reviews/${review.id}/decision`,
    { headers: headers(carol), data: { status: "approved" } },
  );
  expect(approved.ok()).toBeTruthy();
  await append(a, "next", " 审核后的新草稿。");
  const reviews = await (
    await request.get(`/api/documents/${id}/reviews`, {
      headers: headers(alice),
    })
  ).json();
  expect(reviews[0].snapshot).toEqual(before);
  expect(reviews[0].hash).toBe(review.hash);
  expect(reviews[0].status).toBe("approved");
  expect(reviews[0].snapshot).not.toEqual(
    (await getDoc(request, alice, id)).snapshot,
  );
  await cli(alice, id, dir, "sync");
  expect(await fs.readFile(renamed, "utf8")).toContain("审核后的新草稿。");
});

test("重叠修改和增强块变更返回可见冲突，整个导入保持原子性", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    bob = await login(request, "bob"),
    { id } = await createDoc(request, alice),
    a = await open(browser, alice, id),
    b = await open(browser, bob, id),
    base = await exported(request, alice, id);
  await replaceBlock(b, "intro", "用于记录 Mesh 重建。");
  await converge(a, b);
  const current = await snapshot(a),
    md = base.markdown
      .replace("用于记录场景重建。", "用于记录 NeRF 重建。")
      .replace(
        "结论：继续补充实验。",
        "结论：此安全块也不能在冲突时部分写入。",
      );
  await a.getByTestId("markdown").fill(md);
  await a.getByRole("button", { name: "↑ 合并回协作文档" }).click();
  await expect(a.getByTestId("conflicts")).toContainText("intro");
  await expect(a.getByTestId("status-message")).toContainText(
    "线上内容未被覆盖",
  );
  expect(await snapshot(a)).toEqual(current);
  expect(await snapshot(b)).toEqual(current);
  const enhanced = await exported(request, alice, id),
    res = await request.post(`/api/documents/${id}/import`, {
      headers: headers(alice),
      data: {
        opId: randomUUID(),
        markdown: enhanced.markdown.replace('colspan="2"', 'colspan="1"'),
      },
    });
  expect(res.status()).toBe(409);
  expect((await getDoc(request, alice, id)).snapshot).toEqual(current);
  const conflicts = await (
    await request.get(`/api/documents/${id}/conflicts`, {
      headers: headers(alice),
    })
  ).json();
  expect(conflicts.length).toBe(2);
  await a.screenshot({
    path: "validation/artifacts/conflict.png",
    fullPage: true,
  });
});

test("幂等导入、错误基准、伪造元数据与只读权限在服务端处理", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    viewer = await login(request, "viewer"),
    outsider = await login(request, "outsider"),
    { id } = await createDoc(request, alice),
    base = await exported(request, alice, id),
    opId = randomUUID(),
    markdown = base.markdown.replace(
      "结论：继续补充实验。",
      "结论：幂等导入。",
    );
  const first = await request.post(`/api/documents/${id}/import`, {
    headers: headers(alice),
    data: {
      opId,
      markdown,
      author: "admin",
      reviewStatus: "approved",
      baseSnapshot: { forged: true },
    },
  });
  expect(first.ok()).toBeTruthy();
  expect((await first.json()).actor).toBe("alice");
  const second = await request.post(`/api/documents/${id}/import`, {
    headers: headers(alice),
    data: { opId, markdown },
  });
  expect((await second.json()).replayed).toBe(true);
  const reused = await request.post(`/api/documents/${id}/import`, {
    headers: headers(alice),
    data: { opId, markdown: markdown + "\n" },
  });
  expect(reused.status()).toBe(409);
  const wrong = await request.post(`/api/documents/${id}/import`, {
    headers: headers(alice),
    data: {
      opId: randomUUID(),
      markdown: markdown.replace(base.baseId, randomUUID()),
    },
  });
  expect(wrong.status()).toBe(409);
  const deny = await request.post(`/api/documents/${id}/import`, {
    headers: headers(viewer),
    data: { opId: randomUUID(), markdown },
  });
  expect(deny.status()).toBe(403);
  expect(
    (
      await request.get(`/api/documents/${id}`, { headers: headers(outsider) })
    ).status(),
  ).toBe(403);
  const a = await open(browser, alice, id),
    v = await open(browser, viewer, id);
  expect(await v.getByTestId("editor").getAttribute("contenteditable")).toBe(
    "false",
  );
  const before = await snapshot(a);
  await v.evaluate(() => {
    const e = (window as any).__lab.editor;
    e.setEditable(true);
    e.commands.insertContentAt(1, "只读账号非法修改");
  });
  await v.waitForTimeout(700);
  expect((await getDoc(request, alice, id)).snapshot).toEqual(before);
  expect(JSON.stringify(await snapshot(a))).not.toContain("非法修改");
});

test("本地冲突副本、缺失附件和缺失元数据均保留文件并拒绝覆盖", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    { id } = await createDoc(request, alice),
    page = await open(browser, alice, id),
    dir = path.resolve("validation/artifacts/local-errors", id);
  await cli(alice, id, dir, "pull");
  const file = path.join(dir, "研究笔记.md"),
    base = await fs.readFile(file, "utf8"),
    local = base.replace("用于记录场景重建。", "用于记录本地 NeRF 重建。");
  await fs.writeFile(file, local);
  await replaceBlock(page, "intro", "用于记录在线 Mesh 重建。");
  let code: any;
  try {
    await cli(alice, id, dir, "push");
  } catch (e: any) {
    code = e.code;
  }
  expect(code).toBe(2);
  expect(await fs.readFile(file, "utf8")).toBe(local);
  expect((await fs.readdir(path.join(dir, ".anote/conflicts"))).length).toBe(
    1,
  );
  await fs.rename(
    path.join(dir, "assets/before.svg"),
    path.join(dir, "assets/before.svg.missing"),
  );
  await expect(cli(alice, id, dir, "push")).rejects.toThrow("附件未到齐");
  expect(await fs.readFile(file, "utf8")).toBe(local);
  await fs.rename(
    path.join(dir, ".anote", id + ".base.json"),
    path.join(dir, ".anote", id + ".base.json.missing"),
  );
  await expect(cli(alice, id, dir, "push")).rejects.toThrow("同步元数据缺失");
});

test("表格单元格并发编辑收敛；本地删除评论原文后线程保留并标记锚点失效", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    bob = await login(request, "bob"),
    { id } = await createDoc(request, alice),
    a = await open(browser, alice, id),
    b = await open(browser, bob, id);
  async function cell(page: Page, find: string, text: string) {
    await page.evaluate(
      ({ find, text }) => {
        const e = (window as any).__lab.editor;
        let pos = -1;
        e.state.doc.descendants((n: any, p: number) => {
          if (n.type.name === "paragraph" && n.textContent.includes(find))
            pos = p + n.nodeSize - 1;
        });
        if (pos < 0) throw new Error("cell not found");
        e.commands.insertContentAt(pos, text);
      },
      { find, text },
    );
  }
  await Promise.all([
    cell(a, "PSNR", " · Alice 校核"),
    cell(b, "迭代次数", " · Bob 校核"),
  ]);
  await converge(a, b);
  expect(JSON.stringify(block(await snapshot(a), "quality-table"))).toContain(
    "Alice 校核",
  );
  expect(JSON.stringify(block(await snapshot(b), "quality-table"))).toContain(
    "Bob 校核",
  );
  const anchor = await a.evaluate(() =>
    (window as any).__lab.findAnchor("场景重建"),
  );
  const comment = await request.post(`/api/documents/${id}/comments`, {
    headers: headers(alice),
    data: { anchor, text: "原文删除后仍应保留。" },
  });
  expect(comment.ok()).toBeTruthy();
  const base = await exported(request, alice, id);
  const merged = await request.post(`/api/documents/${id}/import`, {
    headers: headers(alice),
    data: {
      opId: randomUUID(),
      markdown: base.markdown.replace("用于记录场景重建。", "用于记录。"),
    },
  });
  expect(merged.ok()).toBeTruthy();
  await converge(a, b);
  const comments = await (
    await request.get(`/api/documents/${id}/comments`, {
      headers: headers(alice),
    })
  ).json();
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toBe("原文删除后仍应保留。");
  expect(comments[0].resolvedAnchor.orphaned).toBe(true);
});

test("保留重启验证样本：协作文档、增强节点、评论和审核记录", async ({
  browser,
  request,
}) => {
  const alice = await login(request),
    carol = await login(request, "carol"),
    { id } = await createDoc(request, alice),
    page = await open(browser, alice, id);
  await append(page, "next", " 重启后应完整保留。");
  await setRange(page, 61);
  await page.getByRole("button", { name: "放大 ＋" }).click();
  const anchor = await page.evaluate(() =>
    (window as any).__lab.findAnchor("场景重建"),
  );
  await request.post(`/api/documents/${id}/comments`, {
    headers: headers(alice),
    data: { anchor, text: "这条评论应在重启后恢复。" },
  });
  const review = await (
    await request.post(`/api/documents/${id}/reviews`, {
      headers: headers(alice),
      data: {},
    })
  ).json();
  await request.post(`/api/documents/${id}/reviews/${review.id}/decision`, {
    headers: headers(carol),
    data: { status: "approved" },
  });
  const exportedBase = await exported(request, alice, id),
    snapshotSaved = (await getDoc(request, alice, id)).snapshot;
  await fs.mkdir("validation/artifacts", { recursive: true });
  await fs.writeFile(
    "validation/artifacts/restart-proof.json",
    JSON.stringify(
      {
        id,
        snapshot: snapshotSaved,
        baseId: exportedBase.baseId,
        markdown: exportedBase.markdown,
        reviewId: review.id,
        reviewHash: review.hash,
      },
      null,
      2,
    ),
  );
});

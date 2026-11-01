import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { api, login } from "./helpers";
import { person } from "./mcp-helpers";
async function setup(page: Page, request: APIRequestContext) {
  const owner = await person(request), book = await api(request, "POST", "spaces", { kind: "personal", name: "媒体排版" }, owner),
    note = await api(request, "POST", "documents", { space_id: book.id, title: "图片和视频排版" }, owner);
  await login(page, owner); await page.goto("/?doc=" + note.id); await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
  await page.getByLabel("上传附件文件", { exact: true }).setInputFiles(["sample.png", "sample.mp4"].map(name => "artifacts/server/fixtures/" + name));
  await expect(page.locator(".media-resource")).toHaveCount(2); await expect(page.locator(".media-resource img")).toHaveJSProperty("naturalWidth", 64);
  return { owner, note, image: page.locator('.media-resource[data-media-kind="image"]'), video: page.locator('.media-resource[data-media-kind="video"]') };
}
async function save(page: Page) { await page.keyboard.press("ControlOrMeta+s"); await expect(page.getByTestId("document-sync")).toHaveText("已保存"); }
test("图片单击选中，尺寸预设、三种对齐、等比拖动、撤销与取消；双击查看", async ({ page, request }) => {
  const { image } = await setup(page, request); await image.locator("img").click();
  await expect(page.getByRole("dialog", { name: "媒体预览", exact: true })).toHaveCount(0);
  const tools = page.getByRole("group", { name: "媒体排版", exact: true }); await expect(tools).toBeVisible();
  await tools.getByLabel("媒体宽度", { exact: true }).selectOption("50");
  const area = (await image.boundingBox())!;
  for (const [label, value] of [["媒体左对齐", "left"], ["媒体居中对齐", "center"], ["媒体右对齐", "right"]]) {
    await tools.getByRole("button", { name: label, exact: true }).click();
    await expect(image.locator(".media-layout")).toHaveAttribute("data-alignment", value);
    const box = (await image.locator("img").boundingBox())!; expect(box.width).toBeCloseTo(area.width * .5, 0); expect(box.width / box.height).toBeCloseTo(1, 2);
    expect(box.x - area.x).toBeCloseTo(value === "left" ? 0 : value === "center" ? (area.width - box.width) / 2 : area.width - box.width, 0);
  }
  const handle = image.getByRole("button", { name: "从右下角调整媒体大小", exact: true });
  await handle.scrollIntoViewIfNeeded(); const start = (await handle.boundingBox())!;
  await page.mouse.move(start.x + 5, start.y + 5); await page.mouse.down(); await page.mouse.move(start.x + 65, start.y + 65, { steps: 6 }); await page.mouse.up();
  // The editor can resize while save feedback disappears. Check the saved
  // percentage, rather than comparing pixels against an earlier parent width.
  expect(Number(await tools.getByLabel("媒体宽度", { exact: true }).inputValue())).toBeGreaterThan(50);
  const grown = (await image.locator("img").boundingBox())!; expect(grown.width / grown.height).toBeCloseTo(1, 2);
  await page.keyboard.press("ControlOrMeta+z"); await expect(tools.getByLabel("媒体宽度", { exact: true })).toHaveValue("50");
  const cancelAt = (await handle.boundingBox())!; await page.mouse.move(cancelAt.x + 5, cancelAt.y + 5); await page.mouse.down(); await page.mouse.move(cancelAt.x - 35, cancelAt.y - 35); await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(tools.getByLabel("媒体宽度", { exact: true })).toHaveValue("50");
  await image.locator("img").dblclick(); const viewer = page.getByRole("dialog", { name: "媒体预览", exact: true }); await expect(viewer).toBeVisible(); await page.keyboard.press("Escape");
  expect(await image.locator("img").evaluate(el => { const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); el.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  await tools.getByLabel("媒体宽度", { exact: true }).selectOption("auto"); await expect(image.locator("img")).toHaveJSProperty("naturalWidth", 64); expect((await image.locator("img").boundingBox())!.width).toBe(64);
});
test("视频与图片排版实时协同、重开保留；只读和匿名分享可单击查看且无排版操作", async ({ page, request, browser }) => {
  const { owner, note, image, video } = await setup(page, request); await save(page);
  const context = await browser.newContext();
  try {
    const peer = await context.newPage(); await login(peer, owner); await peer.goto("/?doc=" + note.id); await expect(peer.locator(".media-resource")).toHaveCount(2);
    await image.locator("img").click(); await page.getByLabel("媒体宽度", { exact: true }).selectOption("25"); await page.getByRole("button", { name: "媒体左对齐", exact: true }).click();
    await expect(peer.locator('.media-resource[data-media-kind="image"] .media-frame')).toHaveAttribute("style", /width: 25%/);
    await expect(peer.locator('.media-resource[data-media-kind="image"] .media-layout')).toHaveAttribute("data-alignment", "left");
    await video.locator("video").click({ position: { x: 30, y: 20 } }); await page.getByLabel("媒体宽度", { exact: true }).selectOption("50"); await page.getByRole("button", { name: "媒体右对齐", exact: true }).click();
    const ratio = await video.locator("video").evaluate(el => el.videoWidth / el.videoHeight), box = (await video.locator("video").boundingBox())!; expect(box.width / box.height).toBeCloseTo(ratio, 2);
    await expect(video.locator("video")).toHaveJSProperty("controls", true);
    await video.locator("video").dblclick({ position: { x: 30, y: 20 } }); await expect(page.getByRole("dialog", { name: "媒体预览", exact: true }).locator("video")).toHaveJSProperty("controls", true); await page.keyboard.press("Escape");
    await save(page); await page.reload(); await expect(image.locator(".media-frame")).toHaveAttribute("style", /width: 25%/); await expect(video.locator(".media-layout")).toHaveAttribute("data-alignment", "right");
    await page.getByRole("button", { name: "阅读", exact: true }).click(); await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    await image.locator("img").click(); await expect(page.getByRole("dialog", { name: "媒体预览", exact: true })).toBeVisible(); await page.keyboard.press("Escape"); await expect(page.locator(".media-format-tools,.media-resize-handle")).toHaveCount(0);
    const link = await api(request, "POST", `documents/${note.id}/sharing/links`, {}, owner), guestContext = await browser.newContext();
    try { const guest = await guestContext.newPage(); await guest.goto(new URL(link.path, page.url()).href); await expect(guest.locator('.media-resource[data-media-kind="image"] .media-frame')).toHaveAttribute("style", /width: 25%/); await expect(guest.locator('.media-resource[data-media-kind="video"] .media-layout')).toHaveAttribute("data-alignment", "right"); await expect(guest.locator(".media-format-tools,.media-resize-handle")).toHaveCount(0); await guest.locator(".media-resource img").click(); await expect(guest.getByRole("dialog", { name: "媒体预览", exact: true })).toBeVisible(); } finally { await guestContext.close(); }
  } finally { await context.close(); }
});
test("旧格式 3 协作客户端被拒绝，防止移除新增媒体排版属性", async ({ page, request }) => {
  const { owner, note } = await setup(page, request); await save(page);
  const before = (await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash, document = new Y.Doc(); let reason = "";
  const provider = new HocuspocusProvider({ url: (process.env.BASE_URL || "http://anote.internal:3000").replace(/^http/, "ws") + "/collab", name: note.id, token: JSON.stringify({ schema: 3, token: owner.token }), document, onAuthenticationFailed: event => { reason = event.reason; } });
  try { await expect.poll(() => reason).toContain("编辑器格式已更新"); expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash).toBe(before); } finally { provider.destroy(); document.destroy(); }
});

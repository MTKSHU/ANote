import { test, expect, type Page, type APIRequestContext, type Locator } from "@playwright/test";
import { api, login, slash } from "./helpers";
import { person } from "./mcp-helpers";

// Exercise a real WebGL renderer on container CI without requiring a GPU.
test.use({ launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });
test.beforeEach(async ({ request }) => {
  expect(["http://anote.internal:3000","http://127.0.0.1:3160"], "Panorama tests require an isolated local test service").toContain(process.env.BASE_URL);
  expect((await request.get("/api/platform/public").then(response => response.json())).public_origin).toBe(process.env.PREVIEW_PUBLIC_ORIGIN||process.env.BASE_URL);
});

async function fixture(page: Page, request: APIRequestContext) {
  const owner = await person(request);
  const library = await api(request, "POST", "spaces", { kind: "personal", name: "360 全景验收" }, owner);
  const note = await api(request, "POST", "documents", { space_id: library.id, title: "全景图片与视频" }, owner);
  await login(page, owner);
  await page.goto("/?doc=" + note.id);
  await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
  return { owner, note };
}

async function panoramaImage(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024; canvas.height = 512;
    const context = canvas.getContext("2d")!;
    ["#ed3333", "#11a855", "#2562db", "#efbb12"].forEach((color, index) => {
      context.fillStyle = color; context.fillRect(index * 256, 0, 256, 512);
      context.fillStyle = "#ffffff"; context.font = "bold 60px sans-serif";
      context.fillText(String(index + 1), index * 256 + 80, 280);
    });
    context.fillStyle = "#222222"; context.fillRect(0, 0, 1024, 60);
    context.fillStyle = "#eeeeee"; context.fillRect(0, 452, 1024, 60);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return { name: "panorama.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

async function uploadImage(page: Page, panoramic = true) {
  const image = await panoramaImage(page);
  if (panoramic) await slash(page, "360° 全景图片");
  await page.getByLabel("上传附件文件", { exact: true }).setInputFiles(image);
  const node = page.locator('.media-resource[data-media-kind="image"]').last();
  await expect(node).toHaveAttribute("data-projection", panoramic ? "equirectangular" : "flat");
  return node;
}

async function save(page: Page) {
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("document-sync")).toHaveText("已保存");
}

async function viewer(page: Page, kind: "图片" | "视频") {
  await page.getByRole("button", { name: "查看360°全景" + kind, exact: true }).click();
  const root = page.getByTestId("panorama-viewer");
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute("data-ready", "true");
  await expect(root.getByTestId("panorama-canvas")).toBeVisible();
  return root;
}

async function dragPanorama(page: Page, root: Locator) {
  const viewport = root.getByTestId("panorama-viewport"), box = (await viewport.boundingBox())!;
  const start = Number(await viewport.getAttribute("data-yaw"));
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .65, box.y + box.height * .55, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await viewport.getAttribute("data-yaw")) - start)).toBeGreaterThan(10);
}

test("全景图片上传后真实球面显示，拖动改变画面，缩放和复位可用，保存重开保留投影", async ({ page, request }) => {
  const { owner, note } = await fixture(page, request);
  await uploadImage(page);
  await save(page);
  const root = await viewer(page, "图片"), viewport = root.getByTestId("panorama-viewport"), canvas = root.getByTestId("panorama-canvas");
  const original = await canvas.screenshot();
  await dragPanorama(page, root);
  await expect.poll(async () => !(await canvas.screenshot()).equals(original)).toBe(true);
  const fov = Number(await viewport.getAttribute("data-fov"));
  await root.getByRole("button", { name: "放大全景", exact: true }).click();
  await expect.poll(async () => Number(await viewport.getAttribute("data-fov"))).toBeLessThan(fov);
  await viewport.focus();
  const yaw = Number(await viewport.getAttribute("data-yaw"));
  await viewport.press("ArrowRight");
  await expect.poll(async () => Number(await viewport.getAttribute("data-yaw"))).not.toBe(yaw);
  await root.getByRole("button", { name: "视角复位", exact: true }).click();
  await expect(viewport).toHaveAttribute("data-yaw", "0");
  await expect(viewport).toHaveAttribute("data-pitch", "0");
  await expect.poll(async () => Number(await viewport.getAttribute("data-fov"))).toBe(fov);
  await root.getByRole("button", { name: "全景全屏", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid"))).toBe("panorama-viewer");
  await page.evaluate(() => document.exitFullscreen());
  await root.screenshot({ path: "artifacts/web/panorama-image.png" });
  await page.keyboard.press("Escape");
  await expect(root).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.media-resource[data-media-kind="image"]')).toHaveAttribute("data-projection", "equirectangular");
  const current = await api(request, "GET", `documents/${note.id}`, undefined, owner);
  expect(current.snapshot.content.find((node: any) => node.type === "mediaResource").attrs.projection).toBe("equirectangular");
  const exported = await api(request, "GET", `documents/${note.id}/export`, undefined, owner);
  expect(exported.markdown).toContain("360° 全景");
});

test("普通图片可切换全景并撤销，回到普通显示保留图片和排版", async ({ page, request }) => {
  const { owner, note } = await fixture(page, request);
  const node = await uploadImage(page, false);
  await node.locator("img").click();
  const display = page.getByLabel("媒体显示方式", { exact: true });
  await expect(display).toHaveValue("flat");
  await page.getByLabel("媒体宽度", { exact: true }).selectOption("50");
  await display.selectOption("equirectangular");
  await expect(node).toHaveAttribute("data-projection", "equirectangular");
  await node.locator("img").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(node).toHaveAttribute("data-projection", "flat");
  await node.locator("img").click();
  await display.selectOption("equirectangular");
  await viewer(page, "图片");
  await page.keyboard.press("Escape");
  await node.locator("img").click();
  await display.selectOption("flat");
  await expect(node).toHaveAttribute("data-projection", "flat");
  await expect(node.locator(".media-frame")).toHaveAttribute("style", /width: 50%/);
  await node.locator("img").dblclick();
  const preview = page.getByRole("dialog", { name: "媒体预览", exact: true });
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 1024);
  await expect(preview.getByTestId("panorama-viewer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await save(page);
  expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).snapshot.content.find((item: any) => item.type === "mediaResource").attrs.projection).toBe("flat");
});

test("全景视频保留球面播放、暂停、进度与音量，关闭释放播放器并能重开", async ({ page, request }) => {
  await fixture(page, request);
  await slash(page, "360° 全景视频");
  await page.getByLabel("上传附件文件", { exact: true }).setInputFiles("artifacts/server/fixtures/panorama.webm");
  await expect(page.locator('.media-resource[data-media-kind="video"]')).toHaveAttribute("data-projection", "equirectangular");
  await save(page);
  const root = await viewer(page, "视频"), video = root.locator("video");
  await expect(video).toHaveJSProperty("videoWidth", 1024);
  await expect(video).toHaveJSProperty("videoHeight", 512);
  await expect(video).toHaveJSProperty("paused", true);
  await expect(video).toHaveJSProperty("playsInline", true);
  await root.getByRole("button", { name: "播放全景视频", exact: true }).click();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.15);
  await root.getByRole("button", { name: "暂停全景视频", exact: true }).click();
  await expect(video).toHaveJSProperty("paused", true);
  const seek = root.getByLabel("全景视频进度", { exact: true });
  await seek.focus(); await seek.press("Home");
  for (let step = 0; step < 10; step++) await seek.press("ArrowRight");
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1);
  await root.getByLabel("全景视频音量", { exact: true }).press("Home");
  await expect(video).toHaveJSProperty("volume", 0);
  await dragPanorama(page, root);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panorama-viewer")).toHaveCount(0);
  await viewer(page, "视频");
  await page.keyboard.press("Escape");
});

test("只读成员与匿名外链能浏览全景但不能修改，公开媒体不请求私有附件接口", async ({ page, request, browser }) => {
  const { owner, note } = await fixture(page, request);
  await uploadImage(page);
  await slash(page, "360° 全景视频");
  await page.getByLabel("上传附件文件", { exact: true }).setInputFiles("artifacts/server/fixtures/panorama.webm");
  await expect(page.locator('.media-resource[data-media-kind="video"]')).toHaveAttribute("data-projection", "equirectangular");
  await save(page);
  const reader = await person(request), sharing = await api(request, "GET", `documents/${note.id}/sharing`, undefined, owner);
  await api(request, "PATCH", `documents/${note.id}/sharing`, { visibility: "private", access_revision: sharing.access_revision, collaborators: [{ user_id: reader.user.id, role: "viewer" }] }, owner);
  const before = (await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash;
  const context = await browser.newContext();
  try {
    const peer = await context.newPage(); await login(peer, reader); await peer.goto("/?doc=" + note.id);
    await expect(peer.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    await expect(peer.getByLabel("媒体显示方式", { exact: true })).toHaveCount(0);
    await dragPanorama(peer, await viewer(peer, "图片")); await peer.keyboard.press("Escape");
    const peerVideo = await viewer(peer, "视频");
    await peerVideo.getByRole("button", { name: "播放全景视频", exact: true }).click();
    await expect.poll(() => peerVideo.locator("video").evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.15);
    await peerVideo.getByRole("button", { name: "暂停全景视频", exact: true }).click();
    await peer.keyboard.press("Escape");
    await api(request, "PATCH", `documents/${note.id}`, { title: "不能修改" }, reader, 403);
  } finally { await context.close(); }
  const link = await api(request, "POST", `documents/${note.id}/sharing/links`, {}, owner), guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage(), privateRequests: string[] = [];
    guest.on("request", value => { if (new URL(value.url()).pathname.startsWith("/api/assets/")) privateRequests.push(value.url()); });
    await guest.goto(new URL(link.path, page.url()).href);
    await expect(guest.getByTestId("editor")).toHaveAttribute("contenteditable", "false");
    await dragPanorama(guest, await viewer(guest, "图片")); await guest.keyboard.press("Escape");
    const publicVideo = await viewer(guest, "视频");
    await expect(publicVideo.locator("video")).toHaveAttribute("src", /^\/api\/public\/notes\//);
    await publicVideo.getByRole("button", { name: "播放全景视频", exact: true }).click();
    await expect.poll(() => publicVideo.locator("video").evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.15);
    await publicVideo.getByRole("button", { name: "暂停全景视频", exact: true }).click();
    await dragPanorama(guest, publicVideo); await guest.keyboard.press("Escape");
    await expect(guest.getByLabel("媒体显示方式", { exact: true })).toHaveCount(0);
    expect(privateRequests).toEqual([]);
  } finally { await guestContext.close(); }
  expect((await api(request, "GET", `documents/${note.id}`, undefined, owner)).hash).toBe(before);
});

test("全景图片加载失败显示明确提示和原件入口，关闭后仍可编辑", async ({ page, request }) => {
  await fixture(page, request);
  const node = await uploadImage(page), source = await node.locator("img").getAttribute("src");
  expect(source).toBeTruthy();
  const pathname = new URL(source!, page.url()).pathname;
  await page.route("**" + pathname + "*", route => route.abort());
  await page.getByRole("button", { name: "查看360°全景图片", exact: true }).click();
  const root = page.getByTestId("panorama-viewer");
  await expect(root.getByRole("alert")).toContainText("无法读取全景图片");
  await expect(root.getByRole("link", { name: "打开原件", exact: true })).toHaveAttribute("href", source!);
  await expect(root).toHaveAttribute("data-ready", "false");
  await page.keyboard.press("Escape");
  await expect(root).toHaveCount(0);
  await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
});

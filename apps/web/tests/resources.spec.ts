import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import { login, createLibrary, createNote, slash } from "./helpers";
import { createHash, randomUUID } from "node:crypto";
test.use({
  launchOptions: {
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  },
});
test("正文内上传、粘贴、拖入，直接选择图片组成双图对比", async ({
  page,
  request,
}) => {
  await login(page);
  await createLibrary(page);
  await createNote(page);
  await page
    .getByLabel("上传附件文件", { exact: true })
    .setInputFiles(
      ["sample.png", "sample.mp4", "sample.wav"].map(
        (v) => "artifacts/server/fixtures/" + v,
      ),
    );
  await expect(page.locator(".media-resource")).toHaveCount(3);
  await expect(page.locator(".media-resource img")).toHaveJSProperty(
    "naturalWidth",
    64,
  );
  await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
  await page.locator("video").evaluate(async (v) => {
    v.muted = true;
    await v.play();
    v.currentTime = 1;
  });
  await expect
    .poll(() => page.locator("video").evaluate((v) => v.currentTime))
    .toBeGreaterThan(1);
  await page.locator("video").evaluate((v) => v.pause());
  for (const [event, name] of [
    ["paste", "粘贴图片.png"],
    ["drop", "拖入图片.png"],
  ]) {
    await page.getByTestId("editor").evaluate(
      (element, { event, name }) => {
        const dt = new DataTransfer();
        dt.items.add(
          new File(
            [
              new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0,
                0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0,
                11, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10,
                45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
              ]),
            ],
            name,
            { type: "image/png" },
          ),
        );
        element.dispatchEvent(
          event === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: dt,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", {
                dataTransfer: dt,
                bubbles: true,
                cancelable: true,
                clientX: element.getBoundingClientRect().left + 20,
                clientY: element.getBoundingClientRect().top + 20,
              }),
        );
      },
      { event, name },
    );
    await expect(
      page.getByAltText(name,{exact:true}),
    ).toBeVisible();
  }
  await slash(page, "双图对比");
  await page.getByLabel("上传附件文件", { exact: true }).setInputFiles(["artifacts/server/fixtures/sample.png", "artifacts/server/fixtures/sample.png"]);
  await expect(page.getByTestId("image-comparison")).toBeVisible();
  await page.reload();
  await expect(page.locator(".media-resource")).toHaveCount(5);
  await expect(page.getByTestId("image-comparison")).toBeVisible();
  await page.getByRole("button", {name:"阅读",exact:true}).click();
  const comparisonButtons = page.getByTestId("image-comparison").locator(".comparison-controls button");
  expect(await comparisonButtons.count()).toBeGreaterThan(0);
  for (const button of await comparisonButtons.all()) await expect(button).toBeEnabled();
  await page.getByRole("button", {name:"编辑",exact:true}).click();
  for (const button of await comparisonButtons.all()) await expect(button).toBeEnabled();
  await page.screenshot({
    path: "artifacts/web/note-attachments.png",
    fullPage: true,
  });
});
test("笔记内 GLB/OBJ/PLY 网格、点云和 Gaussian Splat 实际渲染", async ({
  page,
}) => {
  await login(page);
  await createLibrary(page);
  await createNote(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [filename, buffer] of sceneFixtures()) {
    await page.getByLabel("上传附件文件", { exact: true }).setInputFiles({
      name: filename,
      mimeType: "application/octet-stream",
      buffer,
    });
    const row = page.locator(".media-resource").filter({ hasText: filename });
    await row.getByRole("link", { name: "打开附件 " + filename,exact:true }).click();
    await expect(page.locator(".scene-status")).toContainText("已渲染", {
      timeout: 45000,
    });
    const colors = () => page
      .locator(".scene-canvas canvas")
      .evaluate((canvas: HTMLCanvasElement) => {
        const gl = canvas.getContext("webgl2")!,
          pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        const counts = new Map<string, number>();
        for (let i = 0; i < pixels.length; i += 4) {
          const key = pixels[i] + "," + pixels[i + 1] + "," + pixels[i + 2];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts.values()]
          .sort((a, b) => b - a)
          .slice(1)
          .reduce((a, b) => a + b, 0);
      });
    // GPU updates and resize callbacks may clear a frame before the next draw.
    // Require actual rendered pixels rather than sampling that transient frame.
    await expect.poll(colors,{timeout:15000}).toBeGreaterThan(100);
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  }
  expect(errors).toEqual([]);
});
function sceneFixtures(): Array<[string, Buffer]> {
  const obj = Buffer.from(
    "o Pyramid\nv -1 0 -1\nv 1 0 -1\nv 1 0 1\nv -1 0 1\nv 0 1.6 0\nf 1 2 5\nf 2 3 5\nf 3 4 5\nf 4 1 5\nf 1 4 3 2\n",
  );
  const vertices = "-1 0 0 255 50 50\n1 0 0 50 255 50\n0 1.5 0 50 50 255\n";
  const base =
    "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\n";
  const mesh = Buffer.from(
    base +
      "element face 1\nproperty list uchar int vertex_indices\nend_header\n" +
      vertices +
      "3 0 1 2\n",
  );
  let points = "";
  for (let i = 0; i < 400; i++) {
    const a = i * Math.PI * (3 - Math.sqrt(5)),
      y = 1 - (i / 399) * 2,
      r = Math.sqrt(1 - y * y);
    points += `${Math.cos(a) * r} ${y} ${Math.sin(a) * r} 100 220 150\n`;
  }
  const cloud = Buffer.from(
    base.replace("vertex 3", "vertex 400") + "end_header\n" + points,
  );
  const splats = Buffer.alloc(32 * 300);
  let gaussianHeader =
    "ply\nformat binary_little_endian 1.0\nelement vertex 300\n";
  for (const prop of [
    "x",
    "y",
    "z",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    "opacity",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
  ])
    gaussianHeader += "property float " + prop + "\n";
  const gaussian = Buffer.alloc(300 * 14 * 4);
  for (let i = 0; i < 300; i++) {
    const a = i * 0.47,
      r = 0.5 + 0.25 * Math.sin(i * 0.1),
      x = Math.cos(a) * r,
      y = (i / 299 - 0.5) * 1.7,
      z = Math.sin(a) * r;
    const offset = i * 32;
    splats.writeFloatLE(x, offset);
    splats.writeFloatLE(y, offset + 4);
    splats.writeFloatLE(z, offset + 8);
    for (let k = 0; k < 3; k++) splats.writeFloatLE(0.06, offset + 12 + k * 4);
    splats[offset + 24] = 80 + (i % 170);
    splats[offset + 25] = 180;
    splats[offset + 26] = 230 - (i % 100);
    splats[offset + 27] = 220;
    splats[offset + 28] = 255;
    for (let k = 1; k < 4; k++) splats[offset + 28 + k] = 128;
    [x, y, z, 0.8, 0.2, -0.3, 3, -2.7, -2.7, -2.7, 1, 0, 0, 0].forEach(
      (value, index) => gaussian.writeFloatLE(value, (i * 14 + index) * 4),
    );
  }
  const data = Buffer.alloc(36);
  [-1, -0.8, 0, 1, -0.8, 0, 0, 1, 0].forEach((v, i) =>
    data.writeFloatLE(v, i * 4),
  );
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [
      {
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.3, 0.8, 0.5, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [-1, -0.8, 0],
        max: [1, 1, 0],
      },
    ],
  };
  const json = Buffer.from(JSON.stringify(gltf)),
    padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const glb = Buffer.alloc(12 + 8 + padded.length + 8 + data.length);
  glb.write("glTF");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(glb, 20);
  glb.writeUInt32LE(data.length, 20 + padded.length);
  glb.writeUInt32LE(0x004e4942, 24 + padded.length);
  data.copy(glb, 28 + padded.length);
  return [
    ["pyramid.obj", obj],
    ["triangle.ply", mesh],
    ["cloud.ply", cloud],
    ["triangle.glb", glb],
    [
      "gaussians.ply",
      Buffer.concat([Buffer.from(gaussianHeader + "end_header\n"), gaussian]),
    ],
    ["gaussians.splat", splats],
  ];
}

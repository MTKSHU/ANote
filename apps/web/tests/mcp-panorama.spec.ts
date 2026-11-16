import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { EDITOR_SCHEMA_VERSION } from "@anote/document-model";
import { fixture, grant, connect, call, upload } from "./mcp-helpers";

test.beforeAll(() => {
  expect(process.env.BASE_URL, "全景 MCP 回归只能运行于隔离测试服务").toBe("http://anote.internal:3000");
});

const commit = (client: any, proposal: any) => call(client, "apply_changes", {
  change_id: proposal.change_id,
  preview_hash: proposal.preview_hash,
  operation_id: randomUUID(),
});

async function setup(request: APIRequestContext) {
  const data = await fixture(request), access = await grant(request, data.owner), client = await connect(access.tokens.access_token);
  return { ...data, access, client };
}

test("MCP 已有图片和视频可标为全景，预览后提交、无改动预览和追加文字均保留投影与排版", async ({ request }) => {
  const { note, book, access, client } = await setup(request);
  try {
    const image = await upload(client, request, await fs.readFile("artifacts/server/fixtures/sample.png"), { note_id: note.id }, "全景图片.png");
    const video = await upload(client, request, await fs.readFile("artifacts/server/fixtures/sample.mp4"), { note_id: note.id }, "全景视频.mp4");
    let read = await call(client, "read_note", { note_id: note.id });
    const initial = await call(client, "prepare_changes", {
      note_id: note.id, base_hash: read.base_hash, schema_version: EDITOR_SCHEMA_VERSION,
      operations: [
        { action: "insert", node: { type: "mediaResource", attrs: { assetId: image.upload_id, kind: "image", title: "全景照片", widthPercent: 75, alignment: "right" } } },
        { action: "insert", node: { type: "mediaResource", attrs: { assetId: video.upload_id, kind: "video", title: "全景录像", widthPercent: 50, alignment: "left" } } },
      ],
    });
    await commit(client, initial);
    read = await call(client, "read_note", { note_id: note.id });
    const originals = read.blocks.filter((node: any) => node.type === "mediaResource");
    expect(originals).toHaveLength(2);
    expect(originals.map((node: any) => node.attrs.projection)).toEqual(["flat", "flat"]);
    const panorama = await call(client, "prepare_changes", {
      note_id: note.id, base_hash: read.base_hash, schema_version: EDITOR_SCHEMA_VERSION,
      operations: originals.map((node: any) => ({ action: "replace", block_id: node.attrs.blockId, node: { ...node, attrs: { ...node.attrs, projection: "equirectangular" } } })),
    });
    for (const original of originals) {
      const changed = panorama.diff.find((change: any) => change.block_id === original.attrs.blockId);
      expect(changed.after.attrs).toEqual({ ...original.attrs, projection: "equirectangular" });
    }
    expect((await call(client, "read_note", { note_id: note.id })).base_hash).toBe(read.base_hash);
    await commit(client, panorama);
    read = await call(client, "read_note", { note_id: note.id });
    const panoramas = read.blocks.filter((node: any) => node.type === "mediaResource");
    expect(panoramas.map((node: any) => node.attrs)).toEqual(originals.map((node: any) => ({ ...node.attrs, projection: "equirectangular" })));
    const noop = await call(client, "prepare_changes", { note_id: note.id, base_hash: read.base_hash, schema_version: EDITOR_SCHEMA_VERSION, operations: [] });
    expect(noop.diff).toEqual([]);
    const append = await call(client, "prepare_changes", {
      note_id: note.id, base_hash: read.base_hash, schema_version: EDITOR_SCHEMA_VERSION,
      operations: [{ action: "insert", node: { type: "paragraph", content: [{ type: "text", text: "追加拍摄记录，不修改全景" }] } }],
    });
    expect(append.diff.filter((change: any) => change.after?.type === "mediaResource")).toEqual([]);
    await commit(client, append);
    read = await call(client, "read_note", { note_id: note.id });
    expect(read.blocks.filter((node: any) => node.type === "mediaResource")).toEqual(panoramas);
    const copied = await call(client, "prepare_changes", {
      library_id: book.id, title: "复制全景资料", schema_version: EDITOR_SCHEMA_VERSION,
      operations: panoramas.map((node: any) => ({ action: "insert", node })),
    });
    const created = await commit(client, copied), copy = await call(client, "read_note", { note_id: created.doc_id });
    const copiedMedia = copy.blocks.filter((node: any) => node.type === "mediaResource");
    expect(copiedMedia).toHaveLength(2);
    for (let i = 0; i < copiedMedia.length; i++) {
      expect(copiedMedia[i].attrs).toMatchObject({ projection: "equirectangular", kind: panoramas[i].attrs.kind, widthPercent: panoramas[i].attrs.widthPercent, alignment: panoramas[i].attrs.alignment, hash: panoramas[i].attrs.hash });
      expect(copiedMedia[i].attrs.assetId).not.toBe(panoramas[i].attrs.assetId);
    }
    const rules = await call(client, "get_editor_rules");
    expect(rules.schema_version).toBe(EDITOR_SCHEMA_VERSION);
    expect(rules.toolset_version).toBe('1.1.10');
    expect(rules.node_types.mediaResource.attributes.projection).toBe("flat");
    expect(rules.panoramas).toMatchObject({ attribute: "projection", values: ["flat", "equirectangular"], kinds: ["image", "video"] });
    expect(rules.panoramas.guidance).toContain("2:1");
  } finally { await client.close(); await access.close(); }
});

test("MCP 全景拒绝未知投影、音频和伪造图片类型的普通附件，失败不改原笔记", async ({ request }) => {
  const { note, access, client } = await setup(request);
  try {
    const file = await upload(client, request, Buffer.from("普通文字附件，不能作为 360° 全景"), { note_id: note.id }, "普通附件.txt");
    const audio = await upload(client, request, await fs.readFile("artifacts/server/fixtures/sample.wav"), { note_id: note.id }, "普通音频.wav");
    const before = await call(client, "read_note", { note_id: note.id });
    for (const projection of ["360", "cubemap", "equirectangular;display:none", null]) {
      const error = await call(client, "prepare_changes", {
        note_id: note.id, base_hash: before.base_hash, schema_version: EDITOR_SCHEMA_VERSION,
        operations: [{ action: "insert", node: { type: "mediaResource", attrs: { assetId: file.upload_id, kind: "image", projection } } }],
      }, 400);
      expect(error.error).toContain("媒体显示方式");
    }
    const nonvisual = await call(client, "prepare_changes", {
      note_id: note.id, base_hash: before.base_hash, schema_version: EDITOR_SCHEMA_VERSION,
      operations: [{ action: "insert", node: { type: "mediaResource", attrs: { assetId: audio.upload_id, kind: "audio", projection: "equirectangular" } } }],
    }, 400);
    expect(nonvisual.error).toContain("只支持图片和视频");
    for (const asset of [file, audio]) {
      const mismatch = await call(client, "prepare_changes", {
        note_id: note.id, base_hash: before.base_hash, schema_version: EDITOR_SCHEMA_VERSION,
        operations: [{ action: "insert", node: { type: "mediaResource", attrs: { assetId: asset.upload_id, kind: "image", projection: "equirectangular" } } }],
      }, 400);
      expect(mismatch.error).toContain("全景附件必须是图片或视频");
    }
    const after = await call(client, "read_note", { note_id: note.id });
    expect(after.base_hash).toBe(before.base_hash);
    expect(after.blocks).toEqual(before.blocks);
    expect((await call(client, "upload_status", { upload_id: file.upload_id })).status).toBe("ready");
    await call(client, "cancel_upload", { upload_id: file.upload_id });
    await call(client, "cancel_upload", { upload_id: audio.upload_id });
  } finally { await client.close(); await access.close(); }
});

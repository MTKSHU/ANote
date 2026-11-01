import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Pool } from "pg";
import { EDITOR_SCHEMA_VERSION } from "@anote/document-model";
import { stable } from "@anote/sync-core";
import { api, login } from "./helpers";
import { fixture, grant, connect, call, upload, scopes } from "./mcp-helpers";
async function setup(page: Page, request: APIRequestContext) {
  const { owner, book, note } = await fixture(request); await login(page, owner); await page.goto("/?doc=" + note.id);
  await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable", "true");
  await page.getByLabel("上传附件文件", { exact: true }).setInputFiles("artifacts/server/fixtures/sample.png");
  await expect(page.locator(".media-resource img")).toHaveJSProperty("naturalWidth", 64); await page.locator(".media-resource img").click();
  await page.getByLabel("媒体宽度", { exact: true }).selectOption("75"); await page.getByRole("button", { name: "媒体右对齐", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  const access = await grant(request, owner, scopes, "媒体排版 MCP 验证"), client = await connect(access.tokens.access_token);
  return { owner, book, note, access, client };
}
const commit = (client: any, proposal: any) => call(client, "apply_changes", { change_id: proposal.change_id, preview_hash: proposal.preview_hash, operation_id: randomUUID() });
test("MCP 空预览及只追加文字保留首图 75% 与对齐，显式调整只改变排版且元数据仍由平台决定", async ({ page, request }) => {
  const { note, access, client } = await setup(page, request);
  try {
    let read = await call(client, "read_note", { note_id: note.id }); const picture = read.blocks.find((node: any) => node.type === "mediaResource"), original = structuredClone(picture.attrs);
    expect(original.widthPercent).toBe(75); expect(original.alignment).toBe("right");
    const noop = await call(client, "prepare_changes", { note_id: note.id, base_hash: read.base_hash, schema_version: EDITOR_SCHEMA_VERSION, operations: [] }); expect(noop.diff).toEqual([]);
    const proposal = await call(client, "prepare_changes", { note_id: note.id, base_hash: read.base_hash, schema_version: EDITOR_SCHEMA_VERSION, operations: [{ action: "insert", node: { type: "paragraph", content: [{ type: "text", text: "仅追加这一行" }] } }] });
    expect(proposal.diff.filter((change: any) => change.block_id === original.blockId)).toHaveLength(0); expect((await call(client, "read_note", { note_id: note.id })).base_hash).toBe(read.base_hash);
    await commit(client, proposal); read = await call(client, "read_note", { note_id: note.id }); expect(read.blocks.find((node: any) => node.type === "mediaResource").attrs).toEqual(original);
    const node = structuredClone(read.blocks.find((item: any) => item.type === "mediaResource")); node.attrs = { ...node.attrs, widthPercent: 50, alignment: "left", src: "https://invalid.example/tampered", hash: "fake", bytes: 1, kind: "video", mime: "fake/type" };
    const resize = await call(client, "prepare_changes", { note_id: note.id, base_hash: read.base_hash, schema_version: EDITOR_SCHEMA_VERSION, operations: [{ action: "replace", block_id: original.blockId, node }] });
    const changed = resize.diff.find((change: any) => change.block_id === original.blockId).after.attrs;
    expect(changed.widthPercent).toBe(50); expect(changed.alignment).toBe("left"); for (const field of ["src", "hash", "bytes", "kind", "mime"]) expect(changed[field]).toBe(original[field]);
    await commit(client, resize); read = await call(client, "read_note", { note_id: note.id }); expect(read.blocks.find((item: any) => item.type === "mediaResource").attrs).toEqual({ ...original, widthPercent: 50, alignment: "left" });
    const rules = await call(client, "get_editor_rules"); expect(rules.rules.join(" ")).toContain("widthPercent"); expect(rules.rules.join(" ")).toContain("alignment");
  } finally { await client.close(); await access.close(); }
});
test("MCP 复制已有附件与发布新暂存附件均保留媒体排版，原笔记不改变", async ({ page, request }) => {
  const { note, book, access, client } = await setup(page, request);
  try {
    const source = await call(client, "read_note", { note_id: note.id }), picture = source.blocks.find((node: any) => node.type === "mediaResource");
    const copied = structuredClone(picture); copied.attrs.widthPercent = 60; copied.attrs.alignment = "left";
    const proposal = await call(client, "prepare_changes", { library_id: book.id, title: "复制图片保留排版", schema_version: EDITOR_SCHEMA_VERSION, operations: [{ action: "insert", node: copied }] });
    const copyAttrs = proposal.diff.find((change: any) => change.after?.type === "mediaResource").after.attrs;
    expect(copyAttrs.widthPercent).toBe(60); expect(copyAttrs.assetId).not.toBe(picture.attrs.assetId);
    const result = await commit(client, proposal), read = await call(client, "read_note", { note_id: result.doc_id }); expect(read.blocks[0].attrs.widthPercent).toBe(60); expect(read.blocks[0].attrs.alignment).toBe("left"); expect(read.blocks[0].attrs.hash).toBe(picture.attrs.hash);
    const staged = await upload(client, request, await fs.readFile("artifacts/server/fixtures/sample.png"), { library_id: book.id }, "有排版的图片.png");
    const uploaded = await call(client, "prepare_changes", { library_id: book.id, title: "新附件保留排版", schema_version: EDITOR_SCHEMA_VERSION, operations: [{ action: "insert", node: { type: "mediaResource", attrs: { assetId: staged.upload_id, widthPercent: 25, alignment: "right" } } }] });
    const uploadAttrs = uploaded.diff.find((change: any) => change.after?.type === "mediaResource").after.attrs;
    expect(uploadAttrs.widthPercent).toBe(25); expect(uploadAttrs.alignment).toBe("right");
    const created = await commit(client, uploaded), added = await call(client, "read_note", { note_id: created.doc_id }); expect(added.blocks[0].attrs.widthPercent).toBe(25); expect(added.blocks[0].attrs.alignment).toBe("right");
    expect((await call(client, "read_note", { note_id: note.id })).blocks).toEqual(source.blocks);
  } finally { await client.close(); await access.close(); }
});
test("修复前的媒体预览不能提交，要求重新读取和生成预览，首图 75% 保持不变", async ({ page, request }) => {
  const { owner, note, access, client } = await setup(page, request), sql = new Pool({ host: "db", database: "anote", user: "anote", password: process.env.DB_PASSWORD });
  try {
    expect(process.env.BASE_URL).toBe("http://anote.internal:3000"); const before = await call(client, "read_note", { note_id: note.id });
    const preview = await call(client, "prepare_changes", { note_id: note.id, base_hash: before.base_hash, schema_version: EDITOR_SCHEMA_VERSION, operations: [{ action: "insert", node: { type: "paragraph", content: [{ type: "text", text: "旧预览追加内容" }] } }] });
    const row = (await sql.query("SELECT candidate FROM mcp_changes WHERE id=$1 AND user_id=$2", [preview.change_id, owner.user.id])).rows[0], old = row.candidate; delete old.media_layout_version;
    const media = old.snapshot.content.find((node: any) => node.type === "mediaResource"); media.attrs.widthPercent = null; media.attrs.alignment = "center";
    const hash = createHash("sha256").update(stable(old)).digest("hex"); await sql.query("UPDATE mcp_changes SET candidate=$2,preview_hash=$3 WHERE id=$1 AND user_id=$4", [preview.change_id, old, hash, owner.user.id]);
    const error = await call(client, "apply_changes", { change_id: preview.change_id, preview_hash: hash, operation_id: randomUUID() }, 409); expect(error.error).toContain("媒体排版");
    const after = await call(client, "read_note", { note_id: note.id }); expect(after.base_hash).toBe(before.base_hash); expect(after.blocks.find((node: any) => node.type === "mediaResource").attrs.widthPercent).toBe(75);
  } finally { await sql.end(); await client.close(); await access.close(); }
});

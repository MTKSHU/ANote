import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, EDITOR_SCHEMA_VERSION } from "@anote/document-model";
import { exportMarkdown, mergeMarkdown } from "@anote/sync-core";
import { validateRichDocument } from "../../apps/api/src/mcp-model.js";
const content = () => canonical({ type: "doc", content: [
  { type: "mediaResource", attrs: { blockId: "media", assetId: "sample", kind: "image", localPath: "assets/sample.png", title: "示例", widthPercent: 50, alignment: "right" } },
  { type: "paragraph", attrs: { blockId: "text" }, content: [{ type: "text", text: "初稿" }] },
] });
test("媒体排版保持格式与 Markdown 增强块保真，正文合并保留远端尺寸", () => {
  assert.equal(EDITOR_SCHEMA_VERSION, 4);
  const base = content(), server = structuredClone(base); server.content[0].attrs!.widthPercent = 75;
  const markdown = exportMarkdown("note", "hash", base).replace("初稿", "补充说明"), result = mergeMarkdown(base, server, markdown);
  assert.equal(result.conflicts.length, 0); assert.deepEqual(result.doc.content[0], server.content[0]);
  assert.equal(result.doc.content[1].content![0].text, "补充说明"); assert.deepEqual(validateRichDocument(result.doc), result.doc);
});
test("媒体排版校验拒绝越界宽度、字符串和注入对齐值，兼容未设尺寸的旧资源", () => {
  for (const widthPercent of [0, 4.9, 100.1, "50%", "100;position:fixed"]) {
    const value = content(); value.content[0].attrs!.widthPercent = widthPercent;
    assert.throws(() => validateRichDocument(value));
  }
  const value = content(); value.content[0].attrs!.alignment = "left;display:none"; assert.throws(() => validateRichDocument(value));
  const legacy = canonical({ type: "doc", content: [{ type: "mediaResource", attrs: { assetId: "old", kind: "video" } }] });
  assert.equal(legacy.content[0].attrs!.widthPercent, null); assert.equal(legacy.content[0].attrs!.alignment, "center");
  assert.equal(validateRichDocument(legacy).content[0].attrs!.widthPercent, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { initProseMirrorDoc, prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { canonical, EDITOR_SCHEMA_VERSION, schema, type RichDoc } from "@anote/document-model";
import { exportMarkdown, mergeMarkdown } from "@anote/sync-core";
import { editBlocks, editorRules, validateRichDocument } from "../../apps/api/src/mcp-model.js";

function content(kind: "image" | "video" = "image"): RichDoc {
  return canonical({ type: "doc", content: [
    { type: "mediaResource", attrs: { blockId: "panorama", assetId: "sample", kind, projection: "equirectangular", localPath: `assets/sample.${kind === "image" ? "jpg" : "mp4"}`, title: "全景资料", widthPercent: 75, alignment: "right" } },
    { type: "paragraph", attrs: { blockId: "text" }, content: [{ type: "text", text: "初稿" }] },
  ] });
}

test("全景格式声明与 MCP 规则一致，旧图像和视频默认普通投影", () => {
  assert.equal(EDITOR_SCHEMA_VERSION, 9);
  const rules = editorRules();
  assert.equal(rules.schema_version, EDITOR_SCHEMA_VERSION);
  assert.equal(rules.toolset_version, "1.1.10");
  assert.equal(rules.node_types.mediaResource.attributes.projection, "flat");
  assert.deepEqual(rules.panoramas.values, ["flat", "equirectangular"]);
  for (const kind of ["image", "video", "audio", "file"]) {
    const legacy = validateRichDocument({ type: "doc", content: [{ type: "mediaResource", attrs: { kind } }] });
    assert.equal(legacy.content[0].attrs!.projection, "flat");
  }
  for (const kind of ["image", "video"] as const) assert.deepEqual(validateRichDocument(content(kind)), content(kind));
});

test("全景属性经协作状态重载和 HTML 序列化保留", () => {
  for (const kind of ["image", "video"] as const) {
    const value = content(kind), original = prosemirrorJSONToYDoc(schema, value, "default"), reopened = new Y.Doc();
    try {
      Y.applyUpdate(reopened, Y.encodeStateAsUpdate(original));
      assert.deepEqual(canonical(initProseMirrorDoc(reopened.getXmlFragment("default"), schema).doc.toJSON() as RichDoc), value);
      const media = schema.nodeFromJSON(value).child(0), html = schema.nodes.mediaResource.spec.toDOM!(media) as any[];
      assert.equal(html[0], "figure");
      assert.equal(html[1]["data-projection"], "equirectangular");
      assert.equal(html[1]["data-media-width"], 75);
    } finally { original.destroy(); reopened.destroy(); }
  }
});

test("Markdown 改正文保留全景与排版，远端切换投影不会被旧 Markdown 覆盖", () => {
  const base = content(), remote = structuredClone(base);
  remote.content[0].attrs!.widthPercent = 50;
  const source = exportMarkdown("note", "base", base);
  assert.match(source, /360° 全景（等距柱状投影）/);
  const result = mergeMarkdown(base, remote, source.replace("初稿", "全景拍摄记录"));
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.doc.content[0], remote.content[0]);
  assert.equal(result.doc.content[1].content![0].text, "全景拍摄记录");
  const flat = structuredClone(base); flat.content[0].attrs!.projection = "flat";
  const switched = mergeMarkdown(flat, base, exportMarkdown("note", "base", flat).replace("初稿", "新增说明"));
  assert.deepEqual(switched.conflicts, []);
  assert.equal(switched.doc.content[0].attrs!.projection, "equirectangular");
  const conflict = mergeMarkdown(base, remote, source.replace("全景资料", "本地替换媒体"));
  assert.ok(conflict.conflicts.some(item => item.blockId === "panorama"));
  assert.deepEqual(conflict.doc.content[0], remote.content[0]);
});

test("MCP 拒绝未知投影及非图片视频的全景，修改其他块保留全景属性", () => {
  for (const projection of [null, "360", "cubemap", "equirectangular;display:none", 1, {}]) {
    const value = content(); value.content[0].attrs!.projection = projection;
    assert.throws(() => validateRichDocument(value));
  }
  for (const kind of ["audio", "file", "mesh", "gaussian"]) {
    const value = content(); value.content[0].attrs!.kind = kind;
    assert.throws(() => validateRichDocument(value));
  }
  const base = content("video"), edited = editBlocks(base, [{ action: "replace", block_id: "text", node: { type: "paragraph", content: [{ type: "text", text: "补充正文" }] } }]);
  assert.deepEqual(edited.content[0], base.content[0]);
});

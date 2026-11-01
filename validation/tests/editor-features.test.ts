import test from "node:test";
import assert from "node:assert/strict";
import { canonical } from "@anote/document-model";
import { exportMarkdown, mergeMarkdown } from "@anote/sync-core";
const base = () =>
  canonical({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "intro" },
        content: [
          { type: "text", text: "公式 " },
          { type: "inlineMath", attrs: { latex: "X_t" } },
          { type: "text", text: " 说明" },
        ],
      },
      {
        type: "mathBlock",
        attrs: { blockId: "math", latex: String.raw`X_t=\frac{a}{b}` },
      },
      {
        type: "mindMap",
        attrs: { blockId: "map" },
        content: [
          {
            type: "mindMapItem",
            attrs: { id: "root", parentId: null, x: 100, y: 200 },
            content: [{ type: "text", text: "研究主题" }],
          },
          {
            type: "mindMapItem",
            attrs: { id: "child", parentId: "root", x: 400, y: 300 },
            content: [{ type: "text", text: "实验" }],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { blockId: "code", language: "python" },
        content: [{ type: "text", text: "print('hello')" }],
      },
    ],
  });
test("公式、代码语言与可视化思维导图在 Markdown 往返中保真", () => {
  const value = base(),
    md = exportMarkdown("doc-1", "base-1", value),
    result = mergeMarkdown(value, value, md);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.doc, value);
  assert.match(md, /\$X_t\$/);
  assert.match(md, /```python/);
  assert.match(md, /protected="true"/);
});
test("Markdown 改字保留行内公式；修改独立公式保留 LaTeX 源码", () => {
  const value = base(),
    md = exportMarkdown("doc-1", "base-1", value)
      .replace(" 说明", " 新说明")
      .replace(String.raw`X_t=\frac{a}{b}`, String.raw`Y_t=\sqrt{x}`),
    result = mergeMarkdown(value, value, md);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.doc.content[0].content?.[1].type, "inlineMath");
  assert.equal(result.doc.content[1].attrs?.latex, String.raw`Y_t=\sqrt{x}`);
});
test("思维导图结构修改不可经 Markdown 静默覆盖拖动位置与分支", () => {
  const value = base(),
    remote = structuredClone(value);
  remote.content[2].content![1].attrs!.x = 600;
  const md = exportMarkdown("doc-1", "base-1", value).replace(
      "- 实验",
      "- 外部修改",
    ),
    result = mergeMarkdown(value, remote, md);
  assert.ok(result.conflicts.length);
  assert.deepEqual(result.doc.content[2], remote.content[2]);
});

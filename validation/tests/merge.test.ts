import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  initProseMirrorDoc,
  updateYFragment,
  prosemirrorJSONToYDoc,
} from "@tiptap/y-tiptap";
import { fixture, schema, canonical, type RichDoc } from "../shared/model.js";
import {
  exportMarkdown,
  parseMarkdown,
  mergeMarkdown,
  renderBlock,
} from "../shared/merge.js";
import { findAnchor, resolveAnchor } from "../shared/anchors.js";

const clone = <T>(value: T): T => structuredClone(value);
function replace(doc: RichDoc, id: string, text: string) {
  const node = doc.content.find((n) => n.attrs?.blockId === id)!;
  node.content = [{ type: "text", text }];
  return doc;
}
const exportDoc = (doc: RichDoc) => exportMarkdown("doc-1", "base-1", doc);
const styled = () =>
  canonical({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "styled" },
        content: [
          {
            type: "text",
            text: "实验",
            marks: [
              { type: "bold" },
              {
                type: "textStyle",
                attrs: {
                  color: "#dc2626",
                  fontSize: 20,
                  backgroundColor: "#fef08a",
                },
              },
            ],
          },
          { type: "text", text: "记录", marks: [{ type: "bold" }] },
          { type: "text", text: "，结果完成。" },
        ],
      },
    ],
  });
test("局部颜色、字号、高亮与普通强调在 Markdown 原样往返中完全保真", () => {
  const base = styled(),
    md = exportDoc(base),
    merged = mergeMarkdown(base, base, md);
  assert.match(md, /\*\*实验记录\*\*/);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.changed, []);
  assert.deepEqual(merged.doc, base);
});
test("Markdown 改字继承对应范围颜色、字号和高亮，未选区样式不扩散", () => {
  const base = styled(),
    merged = mergeMarkdown(base, base, exportDoc(base).replace("实验", "训练"));
  assert.deepEqual(merged.conflicts, []);
  const content = merged.doc.content[0].content!;
  assert.equal(content[0].text, "训练");
  assert.deepEqual(content[0].marks, base.content[0].content![0].marks);
  assert.deepEqual(content.slice(1), base.content[0].content!.slice(1));
});
test("线上改样式与本地独立改字可以同时合并", () => {
  const base = styled(),
    remote = clone(base);
  remote.content[0].content![0].marks!.find(
    (m) => m.type === "textStyle",
  )!.attrs!.color = "#2563eb";
  const merged = mergeMarkdown(
    base,
    remote,
    exportDoc(base).replace("结果完成", "结果确认完成"),
  );
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(
    merged.doc.content[0].content![0],
    remote.content[0].content![0],
  );
  assert.match(
    merged.doc.content[0].content!.map((n) => n.text || "").join(""),
    /结果确认完成/,
  );
});
test("跨越不同文字样式的模糊替换保留线上原文和本地冲突", () => {
  const base = styled(),
    merged = mergeMarkdown(
      base,
      base,
      exportDoc(base).replace("实验记录", "新的内容"),
    );
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.doc, base);
  assert.match(merged.conflicts[0].localMarkdown!, /新的内容/);
});
test("本地普通改字保留远端同时新增的字号和高亮", () => {
  const base = canonical({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "plain" },
          content: [{ type: "text", text: "Alpha and Beta" }],
        },
      ],
    }),
    remote = clone(base);
  remote.content[0].content![0].marks = [
    { type: "textStyle", attrs: { fontSize: 24, backgroundColor: "#dbeafe" } },
  ];
  const canonicalRemote = canonical(remote),
    merged = mergeMarkdown(
      base,
      canonicalRemote,
      exportDoc(base).replace("Beta", "Gamma"),
    );
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.doc.content[0].content![0].text, "Alpha and Gamma");
  assert.deepEqual(
    merged.doc.content[0].content![0].marks,
    canonicalRemote.content[0].content![0].marks,
  );
});
test("真实媒体附件与多图片路径在 Markdown 往返中保真，受保护块修改报告冲突", () => {
  const doc = canonical({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "intro" },
        content: [{ type: "text", text: "研究素材说明" }],
      },
      {
        type: "mediaResource",
        attrs: {
          blockId: "video",
          assetId: "asset-video",
          src: "/api/assets/asset-video/file",
          localPath: "assets/asset-video.mp4",
          title: "场景录像",
          kind: "video",
          mime: "video/mp4",
          bytes: 524288000,
          hash: "a".repeat(64),
        },
      },
      {
        type: "imageComparison",
        attrs: {
          blockId: "compare",
          caption: "三种方法",
          layout: "grid",
          images: [1, 2, 3].map((i) => ({
            id: "image-" + i,
            assetId: "image-" + i,
            src: `/api/assets/image-${i}/file`,
            localPath: `assets/image-${i}.png`,
            label: "方法 " + i,
          })),
          zoom: 1.5,
          panX: 20,
        },
      },
    ],
  });
  const markdown = exportDoc(doc);
  assert.match(markdown, /assets\/asset-video\.mp4/);
  assert.match(markdown, /assets\/image-3\.png/);
  assert.doesNotMatch(markdown, /\.svg/);
  const result = mergeMarkdown(
    doc,
    doc,
    markdown.replace("研究素材说明", "本地完善素材说明"),
  );
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.doc.content.slice(1), doc.content.slice(1));
  const tampered = mergeMarkdown(
    doc,
    doc,
    markdown.replace("assets/asset-video.mp4", "assets/other.mp4"),
  );
  assert.ok(tampered.conflicts.length > 0);
});

test("完整导出包含文档和基准 ID、保护标记及可读增强内容", () => {
  const md = exportDoc(fixture()),
    parsed = parseMarkdown(md);
  assert.equal(parsed.docId, "doc-1");
  assert.equal(parsed.baseId, "base-1");
  assert.equal(parsed.sections.length, 6);
  assert.match(md, /colspan="2"/);
  assert.match(md, /rowspan="2"/);
  assert.match(md, /庭院场景/);
});
test("未修改的 Markdown 往返不损失任何富文本节点和属性", () => {
  const base = fixture(),
    merged = mergeMarkdown(base, base, exportDoc(base));
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.doc, base);
  assert.deepEqual(merged.changed, []);
});
test("本地修改与线上不同段落同时保留", () => {
  const base = fixture(),
    remote = replace(clone(base), "next", "线上新增：RTX 4090，训练 30k。"),
    md = exportDoc(base).replace(
      "结论：继续补充实验。",
      "结论：本地记录完成。",
    ),
    merged = mergeMarkdown(base, remote, md);
  assert.equal(merged.conflicts.length, 0);
  assert.equal(
    merged.doc.content.at(-1)?.content?.[0].text,
    "线上新增：RTX 4090，训练 30k。",
  );
  assert.equal(
    merged.doc.content.at(-2)?.content?.[0].text,
    "结论：本地记录完成。",
  );
  assert.deepEqual(merged.doc.content[2], base.content[2]);
  assert.deepEqual(merged.doc.content[3], base.content[3]);
});
test("同一段落的非重叠插入能三方合并", () => {
  const base = fixture(),
    remote = replace(clone(base), "intro", "线上：用于记录场景重建。"),
    md = exportDoc(base).replace(
      "用于记录场景重建。",
      "用于记录场景重建。本地补充。",
    ),
    merged = mergeMarkdown(base, remote, md);
  assert.equal(merged.conflicts.length, 0);
  assert.equal(
    merged.doc.content[1].content?.[0].text,
    "线上：用于记录场景重建。本地补充。",
  );
});
test("同一范围重叠替换返回冲突，保留三个版本", () => {
  const base = fixture(),
    remote = replace(clone(base), "intro", "用于记录 Mesh 重建。"),
    md = exportDoc(base).replace("用于记录场景重建。", "用于记录高斯重建。"),
    merged = mergeMarkdown(base, remote, md);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].blockId, "intro");
  assert.ok(merged.conflicts[0].base);
  assert.ok(merged.conflicts[0].remote);
  assert.ok(merged.conflicts[0].local);
});
test("两端相同的编辑不重复追加", () => {
  const base = fixture(),
    remote = replace(clone(base), "intro", "用于记录场景重建。相同补充。"),
    md = exportDoc(base).replace(
      "用于记录场景重建。",
      "用于记录场景重建。相同补充。",
    ),
    merged = mergeMarkdown(base, remote, md);
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual(merged.doc, remote);
});
test("本地普通文本更新保留线上增强节点的新参数", () => {
  const base = fixture(),
    remote = clone(base);
  remote.content[3].attrs!.slider = 72;
  remote.content[3].attrs!.zoom = 1.75;
  remote.content[2].content![0].content![0].attrs!.background = "#abcdef";
  const merged = mergeMarkdown(
    base,
    remote,
    exportDoc(base).replace("结论：继续补充实验。", "结论：补充完成。"),
  );
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual(merged.doc.content[2], remote.content[2]);
  assert.deepEqual(merged.doc.content[3], remote.content[3]);
});
test("本地修改增强块时显式冲突，不降级覆盖", () => {
  const base = fixture(),
    merged = mergeMarkdown(
      base,
      base,
      exportDoc(base).replace('colspan="2"', 'colspan="1"'),
    );
  assert.equal(merged.conflicts[0].blockId, "quality-table");
  assert.deepEqual(merged.doc.content[2], base.content[2]);
  assert.ok(merged.conflicts[0].localMarkdown?.includes('colspan="1"'));
});
test("删除或重排块进入冲突，不静默删除", () => {
  const base = fixture(),
    md = exportDoc(base).replace(
      /<!-- anote:block id="intro"[\s\S]*?<!-- \/anote:block -->\n\n/,
      "",
    );
  const merged = mergeMarkdown(base, base, md);
  assert.ok(merged.conflicts.some((c) => c.blockId === "intro"));
  assert.deepEqual(merged.doc, base);
});
test("缺失标记、重复 ID 和未识别尾部内容被拒绝", () => {
  const md = exportDoc(fixture());
  assert.throws(() =>
    parseMarkdown(md.replace("anote_base: base-1", "other: base-1")),
  );
  assert.throws(() => parseMarkdown(md.replace('id="next"', 'id="intro"')));
  assert.throws(() => parseMarkdown(md + "未标记的新段落"));
});
test("普通段落支持加粗、斜体和 Unicode 往返", () => {
  const base = fixture();
  base.content[1].content = [
    { type: "text", text: "中文🧪实验", marks: [{ type: "bold" }] },
    { type: "text", text: " 与 " },
    { type: "text", text: "相机参数", marks: [{ type: "italic" }] },
  ];
  const c = canonical(base),
    merged = mergeMarkdown(c, c, exportDoc(c));
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.doc, c);
});
test("标准列表、代码块和引用可往返", () => {
  for (const node of [
    {
      type: "bulletList",
      attrs: { blockId: "new-list" },
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "训练数据" }],
            },
          ],
        },
      ],
    },
    {
      type: "codeBlock",
      attrs: { blockId: "code", language: "python" },
      content: [{ type: "text", text: "seed = 42\nprint(seed)" }],
    },
    {
      type: "blockquote",
      attrs: { blockId: "quote" },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "记录可复现的研究。" }],
        },
      ],
    },
  ]) {
    const doc = canonical({ type: "doc", content: [node] } as RichDoc),
      merged = mergeMarkdown(doc, doc, exportDoc(doc));
    assert.deepEqual(merged.conflicts, [], renderBlock(node as any));
    assert.deepEqual(merged.doc, doc);
  }
});
test("增量回传保留 Yjs 相对评论锚点，且双客户端收敛", () => {
  const base = fixture(),
    doc = prosemirrorJSONToYDoc(schema, base, "default"),
    other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const anchor = findAnchor(doc, "场景重建")!;
  assert.ok(anchor);
  const merged = mergeMarkdown(
      base,
      base,
      exportDoc(base).replace(
        "用于记录场景重建。",
        "本地说明：用于记录场景重建。",
      ),
    ),
    fragment = doc.getXmlFragment("default"),
    { meta } = initProseMirrorDoc(fragment, schema);
  doc.transact(() =>
    updateYFragment(doc, fragment, schema.nodeFromJSON(merged.doc), meta),
  );
  assert.equal(resolveAnchor(doc, anchor).text, "场景重建");
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  assert.equal(resolveAnchor(other, anchor).text, "场景重建");
  assert.deepEqual(
    initProseMirrorDoc(fragment, schema).doc.toJSON(),
    initProseMirrorDoc(other.getXmlFragment("default"), schema).doc.toJSON(),
  );
  doc.destroy();
  other.destroy();
});
test("空白笔记和清空后的普通段落可以往返同步", () => {
  const doc = canonical({
    type: "doc",
    content: [{ type: "paragraph", attrs: { blockId: "empty" } }],
  });
  const md = exportMarkdown("empty-note", "base-empty", doc);
  const merged = mergeMarkdown(doc, doc, md);
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual(merged.doc, doc);
});
test("跨段选区和块级评论能够定位，删除目标后明确失效", () => {
  const doc = prosemirrorJSONToYDoc(schema, fixture(), "default"),
    from = findAnchor(doc, "场景重建")!,
    to = findAnchor(doc, "下一步")!;
  const span = resolveAnchor(doc, { from: from.from, to: to.to });
  assert.equal(span.orphaned, false);
  assert.ok(span.text.includes("场景重建"));
  assert.ok(span.text.includes("下一步"));
  const block = resolveAnchor(doc, { blockId: "quality-table" });
  assert.equal(block.orphaned, false);
  assert.ok(block.text.includes("PSNR"));
  doc.getXmlFragment("default").delete(2, 1);
  assert.equal(resolveAnchor(doc, { blockId: "quality-table" }).orphaned, true);
  doc.getXmlFragment("default").delete(1, 1);
  assert.equal(
    resolveAnchor(doc, { from: from.from, to: to.to }).orphaned,
    true,
  );
  doc.destroy();
});

test("对齐样式在本地 Markdown 改字和线上改样式同时发生时保留，旧文档不增加空属性", () => {
  const legacy = canonical({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "aligned" },
        content: [{ type: "text", text: "实验结果：精度提升。" }],
      },
    ],
  });
  assert.equal(Object.hasOwn(legacy.content[0].attrs!, "textAlign"), false);
  const base = clone(legacy);
  base.content[0].attrs!.textAlign = "center";
  const remote = clone(base);
  remote.content[0].attrs!.textAlign = "right";
  remote.content[0].content![0].text += " 线上补充。";
  const result = mergeMarkdown(
    base,
    remote,
    exportDoc(base).replace("精度提升", "精度提高"),
  );
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.doc.content[0].attrs!.textAlign, "right");
  assert.match(JSON.stringify(result.doc), /精度提高/);
  assert.match(JSON.stringify(result.doc), /线上补充/);
  const localOnly = mergeMarkdown(
    base,
    base,
    exportDoc(base).replace("精度提升", "精度提高"),
  );
  assert.deepEqual(localOnly.conflicts, []);
  assert.equal(localOnly.doc.content[0].attrs!.textAlign, "center");
});

import {
  canonical,
  type RichNode,
  type RichDoc,
} from "@anote/document-model";
const p = (text: string, blockId?: string): RichNode => ({
  type: "paragraph",
  attrs: { blockId: blockId || null },
  content: text ? [{ type: "text", text }] : [],
});
export function fixture(): RichDoc {
  return canonical({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1, blockId: "title" },
        content: [{ type: "text", text: "庭院重建 · 协同研究记录" }],
      },
      p("用于记录场景重建。", "intro"),
      {
        type: "table",
        attrs: { blockId: "quality-table" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {
                  colspan: 2,
                  rowspan: 1,
                  colwidth: [220, 240],
                  background: "#dfece4",
                },
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        marks: [{ type: "bold" }],
                        text: "图像质量与训练配置",
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {
                  colspan: 1,
                  rowspan: 2,
                  colwidth: [220],
                  background: "#f3f7f2",
                },
                content: [p("3D Gaussian Splatting")],
              },
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: [240] },
                content: [
                  p("PSNR：29.36"),
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        marks: [{ type: "italic" }],
                        text: "固定测试视角",
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: [240] },
                content: [p("迭代次数：30000")],
              },
            ],
          },
        ],
      },
      {
        type: "imageComparison",
        attrs: {
          blockId: "comparison",
          images: [
            { id: "before", src: "/fixtures/before.svg", label: "Mesh 基线" },
            { id: "after", src: "/fixtures/after.svg", label: "3DGS 结果" },
          ],
          caption: "庭院场景 · 同机位对比",
          layout: "slider",
          slider: 50,
          zoom: 1,
          panX: 0,
          panY: 0,
        },
      },
      p("结论：继续补充实验。", "conclusion"),
      p("下一步：记录训练配置。", "next"),
    ],
  });
}

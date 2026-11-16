import {
  Extension,
  Mark,
  Node,
  mergeAttributes,
  getSchema,
  type JSONContent,
} from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import {TaskList,TaskItem} from "@tiptap/extension-list";
export {TaskList,TaskItem};
import {
  Table,
  TableRow,
  TableCell,
  TableHeader,
} from "@tiptap/extension-table";
import { Plugin } from "@tiptap/pm/state";
import { newId } from "./id.js";
import { noteIdFromHref } from "./note-links.js";

export interface RichNode {
  type: string;
  attrs?: Record<string, any>;
  content?: RichNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, any> }[];
}
export type RichDoc = { type: "doc"; content: RichNode[] };
export const EDITOR_SCHEMA_VERSION = 9;
export const Mention = Mark.create({
  name:"mention",inclusive:false,excludes:"mention link",
  addAttributes(){return {userId:{default:null,parseHTML:el=>el.getAttribute("data-mention-user")},mentionId:{default:null,parseHTML:el=>el.getAttribute("data-mention-id")},actorId:{default:null,parseHTML:el=>el.getAttribute("data-mention-actor")}};},
  parseHTML(){return [{tag:"span[data-mention-user]"}];},
  renderHTML({mark}){return ["span",{class:"user-mention","data-mention-user":mark.attrs.userId,"data-mention-id":mark.attrs.mentionId,"data-mention-actor":mark.attrs.actorId},0];},
});
const latexAttribute = {
  default: "",
  parseHTML: (el: HTMLElement) => el.getAttribute("data-latex") || "",
  renderHTML: (attrs: Record<string, any>) => ({ "data-latex": attrs.latex }),
};
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return { blockId: { default: null }, latex: latexAttribute };
  },
  parseHTML() {
    return [{ tag: "div[data-math-block]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-math-block": "true" }),
      String(HTMLAttributes["data-latex"] || ""),
    ];
  },
});
export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { latex: latexAttribute };
  },
  parseHTML() {
    return [{ tag: "span[data-inline-math]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-inline-math": "true" }),
      String(HTMLAttributes["data-latex"] || ""),
    ];
  },
});
export const MindMapItem = Node.create({
  name: "mindMapItem",
  content: "text*",
  marks: "",
  defining: true,
  addAttributes() {
    return {
      id: { default: "" },
      parentId: { default: null },
      x: { default: 320 },
      y: { default: 180 },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-mind-map-item]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-mind-map-item": "true" }),
      0,
    ];
  },
});
export const MindMap = Node.create({
  name: "mindMap",
  group: "block",
  content: "mindMapItem+",
  isolating: true,
  draggable: true,
  addAttributes() {
    return { blockId: { default: null },canvasHeight:{default:420,parseHTML:(el:HTMLElement)=>{const height=Number(el.getAttribute("data-canvas-height"));return Number.isInteger(height)&&height>=240&&height<=1600?height:420;},renderHTML:(attrs:Record<string,any>)=>({"data-canvas-height":attrs.canvasHeight||420})} };
  },
  parseHTML() {
    return [{ tag: "section[data-mind-map]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      mergeAttributes(HTMLAttributes, { "data-mind-map": "true" }),
      0,
    ];
  },
});
export const MediaResource = Node.create({
  name: "mediaResource",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      blockId: { default: null },
      assetId: { default: "" },
      src: { default: "" },
      localPath: { default: "" },
      title: { default: "" },
      kind: { default: "file" },
      projection: {
        default: "flat",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-projection") === "equirectangular" ? "equirectangular" : "flat",
        renderHTML: (attrs: Record<string, any>) => ({ "data-projection": attrs.projection === "equirectangular" ? "equirectangular" : "flat" }),
      },
      widthPercent: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const value = Number(el.getAttribute("data-media-width"));
          return Number.isFinite(value) && value >= 5 && value <= 100 ? value : null;
        },
        renderHTML: (attrs: Record<string, any>) => attrs.widthPercent == null ? {} : { "data-media-width": attrs.widthPercent },
      },
      alignment: {
        default: "center",
        parseHTML: (el: HTMLElement) => ["left", "center", "right"].includes(el.getAttribute("data-media-align") || "") ? el.getAttribute("data-media-align") : "center",
        renderHTML: (attrs: Record<string, any>) => ({ "data-media-align": attrs.alignment }),
      },
      mime: { default: "application/octet-stream" },
      bytes: { default: 0 },
      hash: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-media-resource]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "figure",
      mergeAttributes(HTMLAttributes, { "data-media-resource": "true" }),
      ["figcaption", String(HTMLAttributes.title || "资源")],
    ];
  },
});
export const ImageComparison = Node.create({
  name: "imageComparison",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      blockId: { default: null },
      images: { default: [] },
      caption: { default: "" },
      layout: { default: "slider" },
      orientation: { default: "horizontal" },
      slider: { default: 50 },
      zoom: { default: 1 },
      panX: { default: 0 },
      panY: { default: 0 },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-image-comparison]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "figure",
      mergeAttributes(HTMLAttributes, { "data-image-comparison": "true" }),
      ["figcaption", String(HTMLAttributes.caption || "图片对比")],
    ];
  },
});
const background = {
  default: null,
  parseHTML: (element: HTMLElement) => element.style.backgroundColor || null,
  renderHTML: (attrs: Record<string, any>) =>
    attrs.background ? { style: `background-color:${attrs.background}` } : {},
};
const verticalAlign = {
  default: undefined,
  parseHTML: (element: HTMLElement) =>
    ["top", "middle", "bottom"].includes(element.style.verticalAlign)
      ? element.style.verticalAlign : undefined,
  renderHTML: (attrs: Record<string, any>) =>
    ["top", "middle", "bottom"].includes(attrs.verticalAlign)
      ? { style: `vertical-align:${attrs.verticalAlign}` } : {},
};
const ColoredCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), background, verticalAlign };
  },
});
const ColoredHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), background, verticalAlign };
  },
});
// Use the first character's explicit size when present. Changing only an
// inline span's font size must also change the two-character indentation.
// Otherwise em follows the paragraph's font, including the print stylesheet.
export function firstLineIndentCSS(node: RichNode): string | undefined {
  if (node.type !== "paragraph" || node.attrs?.firstLineIndent !== 2) return;
  const first = node.content?.find(child => child.type === "text" && child.text?.length);
  const size = first?.marks?.find(mark => mark.type === "textStyle")?.attrs?.fontSize;
  return FONT_SIZES.includes(size) ? `${size * 2}px` : "2em";
}
export const IndentedParagraph = Paragraph.extend({
  addAttributes() {
    return { ...this.parent?.(), firstLineIndent: {
      default: undefined,
      parseHTML: (element: HTMLElement) =>
        element.dataset.firstLineIndent === "2" || ["2em", "2ic"].includes(element.style.textIndent) ? 2 : undefined,
      renderHTML: () => ({}),
    } };
  },
  renderHTML({ node, HTMLAttributes }) {
    const indent = node.attrs.firstLineIndent === 2 ? firstLineIndentCSS(node.toJSON() as RichNode) : undefined;
    return ["p", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes,
      indent ? { "data-first-line-indent": "2", style: `text-indent:${indent}` } : {}), 0];
  },
  addCommands() {
    return { ...this.parent?.(), setFirstLineIndent: (indent: 2 | null) => ({ state, tr, dispatch }) => {
      if (indent !== 2 && indent !== null) return false;
      const positions = new Set<number>();
      for (const range of state.selection.ranges) {
        state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
          if (node.type.name !== "paragraph") return;
          const point = state.doc.resolve(pos);
          // List markers already provide indentation; do not add a first-line
          // offset to list/task text when a multi-paragraph range includes it.
          for (let depth = point.depth; depth > 0; depth--)
            if (["listItem", "taskItem"].includes(point.node(depth).type.name)) return;
          positions.add(pos);
        });
      }
      if (!positions.size) return false;
      if (dispatch) for (const pos of positions) {
        const node = tr.doc.nodeAt(pos)!;
        if (node.attrs.firstLineIndent !== (indent ?? undefined))
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, firstLineIndent: indent ?? undefined });
      }
      return true;
    } };
  },
});
export const StableBlockId = Extension.create({
  name: "stableBlockId",
  addGlobalAttributes() {
    return [
      {types:["codeBlock"],attributes:{canvasHeight:{default:420,parseHTML:(el:HTMLElement)=>{const height=Number(el.getAttribute("data-canvas-height"));return Number.isInteger(height)&&height>=240&&height<=1600?height:420;},renderHTML:(attrs:Record<string,any>)=>({"data-canvas-height":attrs.canvasHeight||420})}}},
      {
        types: [
          "paragraph",
          "heading",
          "table",
          "codeBlock",
          "bulletList",
          "orderedList",
          "taskList",
          "blockquote",
          "horizontalRule",
        ],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-block-id"),
            renderHTML: (attrs: Record<string, any>) =>
              attrs.blockId ? { "data-block-id": attrs.blockId } : {},
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (_transactions, _old, state) => {
          const tr = state.tr;
          const seen = new Set<string>();
          let changed = false;
          state.doc.forEach((node, pos) => {
            if (
              "blockId" in node.attrs &&
              (!node.attrs.blockId || seen.has(node.attrs.blockId))
            ) {
              const id = newId();
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                blockId: id,
              });
              seen.add(id);
              changed = true;
            } else if (node.attrs.blockId) seen.add(node.attrs.blockId);
          });
          return changed ? tr : null;
        },
      }),
    ];
  },
});
export const TextAlignment = Extension.create({
  name: "academicTextAlignment",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          textAlign: {
            // Undefined keeps unformatted existing documents byte-for-byte compatible.
            default: undefined,
            parseHTML: (element: HTMLElement) =>
              ["left", "center", "right", "justify"].includes(
                element.style.textAlign,
              )
                ? element.style.textAlign
                : undefined,
            renderHTML: (attrs: Record<string, any>) =>
              ["left", "center", "right", "justify"].includes(attrs.textAlign)
                ? { style: `text-align:${attrs.textAlign}` }
                : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setTextAlign:
        (alignment: string) =>
        ({ commands }: any) => {
          if (!["left", "center", "right", "justify"].includes(alignment))
            return false;
          const p = commands.updateAttributes("paragraph", {
            textAlign: alignment,
          });
          const h = commands.updateAttributes("heading", {
            textAlign: alignment,
          });
          return p || h;
        },
    };
  },
});
export const FONT_SIZES = [14, 16, 18, 20, 24, 28];
const validColor = (value: unknown) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
export const AcademicTextStyle = Mark.create({
  name: "textStyle",
  addAttributes() {
    return Object.fromEntries(
      ["color", "fontSize", "backgroundColor"].map((key) => [
        key,
        {
          default: undefined,
          parseHTML: (el: HTMLElement) => {
            if (key === "fontSize") {
              const size = parseFloat(el.style.fontSize);
              return FONT_SIZES.includes(size) &&
                el.style.fontSize.endsWith("px")
                ? size
                : undefined;
            }
            const value =
              key === "color" ? el.style.color : el.style.backgroundColor;
            if (validColor(value)) return value.toLowerCase();
            const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(
              value,
            );
            return rgb && rgb.slice(1).every((v) => Number(v) <= 255)
              ? "#" +
                  rgb
                    .slice(1)
                    .map((v) => Number(v).toString(16).padStart(2, "0"))
                    .join("")
              : undefined;
          },
          renderHTML: () => ({}),
        },
      ]),
    );
  },
  parseHTML() {
    return [
      {
        tag: "span[style]",
        getAttrs: (el: HTMLElement) =>
          el.style.color || el.style.fontSize || el.style.backgroundColor
            ? {}
            : false,
      },
    ];
  },
  renderHTML({ mark }) {
    const a = mark.attrs,
      styles = [];
    if (validColor(a.color)) styles.push(`color:${a.color}`);
    if (FONT_SIZES.includes(a.fontSize))
      styles.push(`font-size:${a.fontSize}px`);
    if (validColor(a.backgroundColor))
      styles.push(`background-color:${a.backgroundColor}`);
    return ["span", styles.length ? { style: styles.join(";") } : {}, 0];
  },
  addCommands() {
    return {
      setAcademicTextStyle:
        (attrs: {
          color?: string;
          fontSize?: number;
          backgroundColor?: string;
        }) =>
        ({ commands, tr, dispatch }: any) => {
          if (
            Object.keys(attrs).some(
              (key) => !["color", "fontSize", "backgroundColor"].includes(key),
            )
          )
            return false;
          if (
            (attrs.color !== undefined && !validColor(attrs.color)) ||
            (attrs.backgroundColor !== undefined &&
              !validColor(attrs.backgroundColor)) ||
            (attrs.fontSize !== undefined &&
              !FONT_SIZES.includes(attrs.fontSize))
          )
            return false;
          const result = commands.setMark("textStyle", attrs);
          if (dispatch) {
            const { empty, ranges } = tr.selection;
            if (empty) {
              const mark = (tr.storedMarks || []).find(
                (m: any) => m.type.name === "textStyle",
              );
              if (mark && !Object.values(mark.attrs).some(Boolean))
                tr.removeStoredMark(mark.type);
            } else
              for (const range of ranges) {
                const from = range.$from.pos,
                  to = range.$to.pos;
                tr.doc.nodesBetween(from, to, (node: any, pos: number) => {
                  const mark = node.marks.find(
                    (m: any) => m.type.name === "textStyle",
                  );
                  if (
                    node.isText &&
                    mark &&
                    !Object.values(mark.attrs).some(Boolean)
                  )
                    tr.removeMark(
                      Math.max(from, pos),
                      Math.min(to, pos + node.nodeSize),
                      mark,
                    );
                });
              }
          }
          return result;
        },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphIndent: { setFirstLineIndent: (indent: 2 | null) => ReturnType };
    academicTextAlignment: { setTextAlign: (alignment: string) => ReturnType };
    academicTextStyle: {
      setAcademicTextStyle: (attrs: {
        color?: string;
        fontSize?: number;
        backgroundColor?: string;
      }) => ReturnType;
    };
  }
}
export function extensions() {
  return [
    StarterKit.configure({
      paragraph: false,
      undoRedo: false,
      link: {
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        defaultProtocol: "https",
        isAllowedUri: (url, ctx) =>
          !!noteIdFromHref(url) || ctx.defaultValidate(url) &&
          (/^(https?:\/\/|mailto:)/i.test(url) ||
            /^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#][^\s]*)?$/.test(url)),
      },
    }),
    StableBlockId,
    IndentedParagraph,
    TaskList,
    TaskItem.configure({nested:true,a11y:{checkboxLabel:node=>"待办："+(node.textContent||"空白待办")}}),
    TextAlignment,
    AcademicTextStyle,
    Table.configure({ resizable: true }),
    TableRow,
    ColoredCell,
    ColoredHeader,
    ImageComparison,
    MediaResource,
    MindMap,
    MindMapItem,
    MathBlock,
    InlineMath,
    Mention,
  ];
}
export const schema = getSchema(extensions());
export function canonical(doc: RichDoc): RichDoc {
  return JSON.parse(
    JSON.stringify(schema.nodeFromJSON(doc).toJSON()),
  ) as RichDoc;
}
export const blockId = (node: RichNode) => String(node.attrs?.blockId || "");
export function textOf(node: RichNode): string {
  return node.text || node.content?.map(textOf).join("") || "";
}

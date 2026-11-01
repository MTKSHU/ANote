import { diffArrays } from "diff";
import MarkdownIt from "markdown-it";
import { mathMarkdown } from "./math-markdown.js";
import { taskMarkdown } from "./task-markdown.js";
import type Token from "markdown-it/lib/token.mjs";
import {
  canonical,
  blockId,
  textOf,
  type RichDoc,
  type RichNode,
} from "@anote/document-model";

export const stable = (value: any): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const equal = (a: any, b: any) => stable(a) === stable(b);
const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
md.use(mathMarkdown);
md.use(taskMarkdown);
const esc = (s: string) => s.replace(/[\\`*_\[\]<>]/g, "\\$&");
const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const isRich = (node: RichNode) =>
  ["table", "imageComparison", "mediaResource", "mindMap"].includes(node.type);
function inline(nodes: RichNode[] = []): string {
  const readable: RichNode[] = [];
  for (const node of nodes) {
    const n = {
        ...node,
        ...(node.marks
          ? { marks: node.marks.filter((m) => m.type !== "textStyle") }
          : {}),
      },
      prev = readable.at(-1);
    if (
      n.type === "text" &&
      prev?.type === "text" &&
      equal(n.marks || [], prev.marks || [])
    )
      prev.text = (prev.text || "") + (n.text || "");
    else readable.push(n);
  }
  return readable
    .map((n) => {
      if (n.type === "hardBreak") return "  \n";
      if (n.type === "inlineMath")
        return "$" + String(n.attrs?.latex || "") + "$";
      if (n.type !== "text") throw new Error(`不支持的行内节点：${n.type}`);
      let s = esc(n.text || "");
      for (const mark of n.marks || []) {
        if (mark.type === "bold") s = `**${s}**`;
        else if (mark.type === "italic") s = `*${s}*`;
        else if (mark.type === "strike") s = `~~${s}~~`;
        else if (mark.type === "code")
          s = "`" + (n.text || "").replace(/`/g, "\\`") + "`";
        else if (mark.type === "link") s = `[${s}](${mark.attrs?.href})`;
        else throw new Error(`不支持的行内格式：${mark.type}`);
      }
      return s;
    })
    .join("");
}
export function renderBlock(n: RichNode): string {
  if (n.type === "mathBlock")
    return "$$\n" + String(n.attrs?.latex || "") + "\n$$";
  if (n.type === "paragraph") return inline(n.content);
  if (n.type === "heading")
    return "#".repeat(n.attrs?.level || 1) + " " + inline(n.content);
  if (n.type === "codeBlock") {
    const fence = "`".repeat(
      Math.max(3, ...(textOf(n).match(/`+/g) || []).map((s) => s.length + 1)),
    );
    return `${fence}${n.attrs?.language || ""}\n${textOf(n)}\n${fence}`;
  }
  if (n.type === "horizontalRule") return "---";
  if (n.type === "blockquote")
    return (n.content || [])
      .map(renderBlock)
      .join("\n\n")
      .split("\n")
      .map((l) => "> " + l)
      .join("\n");
  if (n.type === "bulletList" || n.type === "orderedList" || n.type === "taskList")
    return (n.content || [])
      .map((li, i) => {
        const marker =
          n.type === "orderedList" ? `${(n.attrs?.start || 1) + i}. ` : n.type === "taskList" ? `- [${li.attrs?.checked ? "x" : " "}] ` : "- ";
        return (
          marker +
          (li.content || [])
            .map(renderBlock)
            .join("\n\n")
            .split("\n")
            .map((l, j) => (j ? " ".repeat(n.type==="taskList"?2:marker.length) + l : l))
            .join("\n")
        );
      })
      .join("\n");
  if (n.type === "table")
    return (
      "<table>\n" +
      (n.content || [])
        .map(
          (row) =>
            "<tr>" +
            row.content
              ?.map(
                (cell) =>
                  `<${cell.type === "tableHeader" ? "th" : "td"} colspan="${cell.attrs?.colspan || 1}" rowspan="${cell.attrs?.rowspan || 1}">${(cell.content || []).map((c) => html(textOf(c))).join("<br>")}</${cell.type === "tableHeader" ? "th" : "td"}>`,
              )
              .join("") +
            "</tr>",
        )
        .join("\n") +
      "\n</table>\n\n> 增强表格的合并、宽度、样式和单元格富文本由结构化版本保留，请在网页中编辑。"
    );
  if (n.type === "imageComparison")
    return (
      `**${esc(n.attrs?.caption || "双图对比")}**\n\n` +
      (n.attrs?.images || [])
        .map(
          (im: any) =>
            `![${esc(im.label)}](${im.localPath || `assets/${im.id}.svg`})`,
        )
        .join("\n\n") +
      "\n\n> 滑动对比和联动视图由结构化版本保留，请在网页中编辑。"
    );
  if (n.type === "mediaResource")
    return `${n.attrs?.kind === "image" ? "!" : ""}[${esc(n.attrs?.title || "资源")}](${n.attrs?.localPath})\n\n> 媒体预览与资源信息由结构化版本保留，请在应用中编辑。`;
  if (n.type === "mindMap") {
    const items = n.content || [],
      visited = new Set<RichNode>();
    const branch = (item: RichNode, depth: number): string[] => {
      if (visited.has(item)) return [];
      visited.add(item);
      return [
        "  ".repeat(Math.min(depth, 30)) +
          "- " +
          textOf(item).replace(/\n/g, " "),
        ...items
          .filter((child) => child.attrs?.parentId === item.attrs?.id)
          .flatMap((child) => branch(child, depth + 1)),
      ];
    };
    const lines = items
      .filter(
        (item) =>
          !item.attrs?.parentId ||
          !items.some((parent) => parent.attrs?.id === item.attrs?.parentId),
      )
      .flatMap((item) => branch(item, 0));
    for (const item of items) lines.push(...branch(item, 0));
    return (
      "**思维导图**\n\n" +
      lines.join("\n") +
      "\n\n> 节点位置与分支由结构化版本保留，请在应用中编辑。"
    );
  }
  throw new Error(`不支持的块：${n.type}`);
}
export function exportMarkdown(
  docId: string,
  baseId: string,
  doc: RichDoc,
): string {
  return (
    `---\nanote_doc: ${docId}\nanote_base: ${baseId}\n---\n\n` +
    doc.content
      .map(
        (n) =>
          `<!-- anote:block id="${blockId(n)}" type="${n.type}"${isRich(n) ? ' protected="true"' : ""} -->\n${renderBlock(n)}\n<!-- /anote:block -->`,
      )
      .join("\n\n") +
    "\n"
  );
}
export type Section = {
  id: string;
  type: string;
  body: string;
  protected: boolean;
};
export function parseMarkdown(source: string): {
  docId: string;
  baseId: string;
  sections: Section[];
} {
  if (source.length > 2 * 1024 * 1024)
    throw new Error("Markdown 超过验证原型的 2 MB 限制");
  const header =
    /^---\r?\nanote_doc: ([\w-]+)\r?\nanote_base: ([\w-]+)\r?\n---\s*/.exec(
      source,
    );
  if (!header) throw new Error("缺少或损坏文档 ID／基准版本");
  const rest = source.slice(header[0].length),
    re =
      /<!-- anote:block id="([\w-]+)" type="([\w]+)"( protected="true")? -->\r?\n([\s\S]*?)\r?\n<!-- \/anote:block -->/g;
  const sections: Section[] = [];
  let last = 0,
    match;
  while ((match = re.exec(rest))) {
    if (rest.slice(last, match.index).trim())
      throw new Error(
        "块标记之外出现内容；请在已有普通块中编辑或使用明确的新块标记",
      );
    if (sections.some((s) => s.id === match![1])) throw new Error("块 ID 重复");
    sections.push({
      id: match[1],
      type: match[2],
      protected: !!match[3],
      body: match[4],
    });
    last = re.lastIndex;
  }
  if (rest.slice(last).trim()) throw new Error("块标记不完整或存在未识别内容");
  if (!sections.length) throw new Error("文档不包含有效块");
  return { docId: header[1], baseId: header[2], sections };
}
function parseInline(tokens: Token[] = []): RichNode[] {
  const out: RichNode[] = [],
    marks: any[] = [];
  const push = (text: string, extra?: any) => {
    if (text)
      out.push({
        type: "text",
        text,
        ...(marks.length || extra
          ? { marks: [...marks, ...(extra ? [extra] : [])] }
          : {}),
      });
  };
  for (const t of tokens) {
    if (t.type === "math_inline") {
      out.push({ type: "inlineMath", attrs: { latex: t.content } });
      continue;
    }
    if (t.type === "text") push(t.content);
    else if (t.type === "code_inline") push(t.content, { type: "code" });
    else if (t.type === "softbreak") push("\n");
    else if (t.type === "hardbreak") out.push({ type: "hardBreak" });
    else if (
      ["strong_open", "em_open", "s_open", "link_open"].includes(t.type)
    ) {
      const type = {
        strong_open: "bold",
        em_open: "italic",
        s_open: "strike",
        link_open: "link",
      }[t.type]!;
      marks.push({
        type,
        ...(type === "link"
          ? {
              attrs: {
                href: t.attrGet("href"),
                target: null,
                rel: null,
                class: null,
                title: t.attrGet("title"),
              },
            }
          : {}),
      });
    } else if (t.type.endsWith("_close")) marks.pop();
    else throw new Error(`Markdown 行内语法尚未验证：${t.type}`);
  }
  return out;
}
export function parseStandard(section: Section): RichNode {
  if (section.type === "mathBlock") {
    const match = /^\s*\$\$([\s\S]*?)\$\$\s*$/.exec(section.body);
    if (!match) throw new Error("独立公式需要使用 $$ 包围");
    return canonical({
      type: "doc",
      content: [
        {
          type: "mathBlock",
          attrs: { blockId: section.id, latex: match[1].trim() },
        },
      ],
    }).content[0];
  }
  if (section.type === "paragraph" && !section.body.trim())
    return canonical({
      type: "doc",
      content: [{ type: "paragraph", attrs: { blockId: section.id } }],
    }).content[0];
  const tokens = md.parse(section.body, {});
  let i = 0;
  const read = (stop?: string): RichNode[] => {
    const nodes: RichNode[] = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t.type === stop) return nodes;
      if (t.type === "inline") {
        nodes.push(...parseInline(t.children || []));
        continue;
      }
      if (t.type === "paragraph_open") {
        nodes.push({ type: "paragraph", content: read("paragraph_close") });
        continue;
      }
      if (t.type === "heading_open") {
        nodes.push({
          type: "heading",
          attrs: { level: Number(t.tag.slice(1)) },
          content: read("heading_close"),
        });
        continue;
      }
      if (t.type === "fence" || t.type === "code_block") {
        nodes.push({
          type: "codeBlock",
          attrs: { language: t.info.trim() || null },
          content: t.content
            ? [{ type: "text", text: t.content.replace(/\n$/, "") }]
            : [],
        });
        continue;
      }
      if (t.type === "hr") {
        nodes.push({ type: "horizontalRule" });
        continue;
      }
      const containers: Record<string, [string, string]> = {
        blockquote_open: ["blockquote", "blockquote_close"],
        bullet_list_open: ["bulletList", "bullet_list_close"],
        ordered_list_open: ["orderedList", "ordered_list_close"],
        list_item_open: ["listItem", "list_item_close"],
      };
      if (containers[t.type]) {
        let [type, end] = containers[t.type];
        if(t.attrGet("data-type")==="taskList")type="taskList";
        if(t.attrGet("data-type")==="taskItem")type="taskItem";
        nodes.push({
          type,
          ...(type === "taskItem" ? {attrs:{checked:t.attrGet("data-checked")==="true"}} : type === "orderedList"
            ? { attrs: { start: Number(t.attrGet("start") || 1) } }
            : {}),
          content: read(end),
        });
        continue;
      }
      throw new Error(`Markdown 块语法尚未验证：${t.type}`);
    }
    return nodes;
  };
  const nodes = read();
  if (nodes.length !== 1 || nodes[0].type !== section.type)
    throw new Error("块类型或数量变化需要结构化冲突处理");
  const result = nodes[0];
  result.attrs = { ...result.attrs, blockId: section.id };
  return canonical({ type: "doc", content: [result] }).content[0];
}
type Char = {
  c: string;
  marks?: any[];
  hardBreak?: boolean;
  inlineMath?: string;
};
const chars = (n: RichNode): Char[] => {
  if (!["paragraph", "heading", "codeBlock"].includes(n.type))
    throw new Error("非文本块");
  return (n.content || []).flatMap((c) =>
    c.type === "text"
      ? Array.from(c.text || "").map((v) => ({
          c: v,
          ...(c.marks?.length ? { marks: c.marks } : {}),
        }))
      : c.type === "inlineMath"
        ? [
            {
              c: "\ufffc" + String(c.attrs?.latex || ""),
              inlineMath: String(c.attrs?.latex || ""),
            },
          ]
        : c.type === "hardBreak"
          ? [{ c: "\n", hardBreak: true }]
          : (() => {
              throw new Error("不支持的行内节点");
            })(),
  );
};
const stripStyle = (value: Char): Char => ({
  ...value,
  marks: (value.marks || []).filter((m) => m.type !== "textStyle"),
});
const sameContent = (a: Char, b: Char) => equal(stripStyle(a), stripStyle(b));
const styleOf = (value: Char | undefined) =>
  value?.marks?.find((m) => m.type === "textStyle");
function putStyle(value: Char, style: any): Char {
  const marks = (value.marks || []).filter((m) => m.type !== "textStyle");
  if (style) marks.push(style);
  const { marks: old, ...rest } = value;
  return { ...rest, ...(marks.length ? { marks } : {}) };
}
// Align text independently of presentation. Ambiguous replacements across styles
// become visible conflicts instead of silently discarding the original marks.
function inheritStyles(source: Char[], target: Char[]): Char[] {
  const out: Char[] = [];
  let sourceOffset = 0,
    targetOffset = 0;
  const parts = diffArrays(source, target, {
    comparator: (a, b) => a.c === b.c && !!a.hardBreak === !!b.hardBreak,
  });
  let removed: Char[] = [];
  for (const part of parts) {
    if (part.removed) {
      removed.push(...part.value);
      sourceOffset += part.value.length;
      continue;
    }
    if (part.added) {
      const styles = removed.map(styleOf),
        unique = [
          ...new Map(styles.map((s) => [stable(s || null), s])).values(),
        ];
      if (unique.length > 1)
        throw new Error(
          "本地改字跨越不同文字样式，需要确认；线上样式与本地内容均已保留",
        );
      const style = removed.length
        ? unique[0]
        : styleOf(source[sourceOffset - 1]) || styleOf(source[sourceOffset]);
      out.push(
        ...target
          .slice(targetOffset, targetOffset + part.value.length)
          .map((c) => putStyle(c, style)),
      );
      targetOffset += part.value.length;
      removed = [];
      continue;
    }
    removed = [];
    for (let i = 0; i < part.value.length; i++)
      out.push(
        putStyle(target[targetOffset + i], styleOf(source[sourceOffset + i])),
      );
    sourceOffset += part.value.length;
    targetOffset += part.value.length;
  }
  return out;
}
function textContent(values: Char[]): RichNode[] {
  const content: RichNode[] = [];
  for (const c of values) {
    if (c.inlineMath !== undefined) {
      content.push({ type: "inlineMath", attrs: { latex: c.inlineMath } });
      continue;
    }
    if (c.hardBreak) {
      content.push({ type: "hardBreak" });
      continue;
    }
    const prev = content.at(-1);
    if (prev?.type === "text" && equal(prev.marks || [], c.marks || []))
      prev.text = (prev.text || "") + c.c;
    else
      content.push({
        type: "text",
        text: c.c,
        ...(c.marks?.length ? { marks: c.marks } : {}),
      });
  }
  return content;
}
function inheritInlineStyles(base: RichNode, local: RichNode) {
  if (base.type !== local.type) return;
  if (["paragraph", "heading"].includes(base.type)) {
    local.content = textContent(inheritStyles(chars(base), chars(local)));
    return;
  }
  if (base.content?.length === local.content?.length)
    for (let i = 0; i < (base.content?.length || 0); i++)
      inheritInlineStyles(base.content![i], local.content![i]);
  else if (stable(base).includes('"type":"textStyle"'))
    throw new Error("带样式内容的结构发生变化，需要人工确认；原格式已保留");
}

type Edit = { start: number; end: number; value: Char[] };
function edits(base: Char[], next: Char[]): Edit[] {
  const out: Edit[] = [];
  let offset = 0,
    pending: Edit | undefined;
  for (const part of diffArrays(base, next, { comparator: sameContent })) {
    if (part.added) {
      if (!pending) pending = { start: offset, end: offset, value: [] };
      pending.value.push(...part.value);
    } else if (part.removed) {
      if (!pending) pending = { start: offset, end: offset, value: [] };
      offset += part.value.length;
      pending.end = offset;
    } else {
      if (pending) {
        out.push(pending);
        pending = undefined;
      }
      offset += part.value.length;
    }
  }
  if (pending) out.push(pending);
  return out;
}
function overlap(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start < b.end;
  if (b.start === b.end) return b.start >= a.start && b.start < a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}
// Markdown edits text; alignment remains in the structured document/sidecar.
const withoutAlignment = (attrs: RichNode["attrs"]) => {
  if (!attrs) return attrs;
  const { textAlign, ...rest } = attrs;
  return rest;
};
function inheritAlignment(base: RichNode, local: RichNode) {
  if (base.type !== local.type) return;
  if (base.attrs?.textAlign)
    local.attrs = { ...local.attrs, textAlign: base.attrs.textAlign };
  if (base.content?.length === local.content?.length)
    for (let i = 0; i < (base.content?.length || 0); i++)
      inheritAlignment(base.content![i], local.content![i]);
}
function mergeInline(
  base: RichNode,
  remote: RichNode,
  local: RichNode,
): RichNode | null {
  if (
    base.type !== remote.type ||
    base.type !== local.type ||
    !equal(withoutAlignment(base.attrs), withoutAlignment(remote.attrs)) ||
    !equal(withoutAlignment(base.attrs), withoutAlignment(local.attrs))
  )
    return null;
  let bc: Char[], rc: Char[], lc: Char[];
  try {
    bc = chars(base);
    rc = chars(remote);
    lc = inheritStyles(rc, chars(local));
  } catch {
    return null;
  }
  const sameEdit = (a: Edit, b: Edit) =>
    a.start === b.start &&
    a.end === b.end &&
    equal(a.value.map(stripStyle), b.value.map(stripStyle));
  const re = edits(bc, rc),
    le = edits(bc, lc),
    all = [...re];
  for (const l of le) {
    if (re.some((r) => overlap(r, l) && !sameEdit(r, l))) return null;
    if (!re.some((r) => sameEdit(r, l))) all.push(l);
  }
  let merged: Char[];
  try {
    merged = inheritStyles(rc, bc);
  } catch {
    return null;
  }
  for (const e of all.sort((a, b) => b.start - a.start || b.end - a.end))
    merged.splice(e.start, e.end - e.start, ...e.value);
  return { ...remote, content: textContent(merged) };
}
export type Conflict = {
  blockId: string;
  reason: string;
  base?: RichNode;
  remote?: RichNode;
  local?: RichNode;
  localMarkdown?: string;
};
export function mergeMarkdown(
  base: RichDoc,
  remote: RichDoc,
  source: string,
): { doc: RichDoc; conflicts: Conflict[]; changed: string[] } {
  const parsed = parseMarkdown(source),
    sections = new Map(parsed.sections.map((s) => [s.id, s])),
    baseMap = new Map(base.content.map((n) => [blockId(n), n])),
    remoteMap = new Map(remote.content.map((n) => [blockId(n), n]));
  const conflicts: Conflict[] = [],
    changed: string[] = [],
    updates = new Map<string, RichNode>();
  if (
    parsed.sections.map((s) => s.id).join("|") !==
    base.content.map(blockId).join("|")
  )
    conflicts.push({
      blockId: "document",
      reason: "块删除、插入或重排尚未开放自动合并，需要人工确认",
    });
  for (const [id, b] of baseMap) {
    const section = sections.get(id),
      r = remoteMap.get(id);
    if (!section) {
      conflicts.push({
        blockId: id,
        reason: "本地块被删除，需确认",
        base: b,
        remote: r,
      });
      continue;
    }
    if (!r) {
      if (section.body !== renderBlock(b))
        conflicts.push({
          blockId: id,
          reason: "线上已删除此块，本地同时修改",
          base: b,
          localMarkdown: section.body,
        });
      continue;
    }
    if (isRich(b)) {
      if (
        section.type !== b.type ||
        !section.protected ||
        section.body !== renderBlock(b)
      )
        conflicts.push({
          blockId: id,
          reason: "增强块的本地结构发生变化，需在网页确认；原结构已保留",
          base: b,
          remote: r,
          localMarkdown: section.body,
        });
      continue;
    }
    let l: RichNode;
    try {
      if (section.protected) throw new Error("普通块保护属性不正确");
      l = parseStandard(section);
      inheritAlignment(b, l);
      inheritInlineStyles(b, l);
    } catch (e) {
      conflicts.push({
        blockId: id,
        reason: (e as Error).message,
        base: b,
        remote: r,
        localMarkdown: section.body,
      });
      continue;
    }
    if (equal(l, b)) continue;
    let result: RichNode | null =
      equal(r, b) || equal(r, l) ? l : mergeInline(b, r, l);
    if (!result) {
      conflicts.push({
        blockId: id,
        reason: "两端修改范围重叠，已保留线上和本地版本",
        base: b,
        remote: r,
        local: l,
      });
      continue;
    }
    updates.set(id, result);
    changed.push(id);
  }
  return {
    doc: canonical({
      type: "doc",
      content: remote.content.map((n) => updates.get(blockId(n)) || n),
    }),
    conflicts,
    changed,
  };
}

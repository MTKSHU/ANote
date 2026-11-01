import { t as translateUI } from "@anote/i18n";
import React, { useState } from "react";
import { Extension, InputRule } from "@tiptap/core";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { useEditorEditable } from "./editable-state.js";
export function MathView({ node, editor, updateAttributes }: NodeViewProps) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(node.attrs.latex);
  const block = node.type.name === "mathBlock";
  const editable = useEditorEditable(editor);
  let html = "";
  try {
    html = katex.renderToString(
      String(node.attrs.latex || "").slice(0, 20000),
      {
        displayMode: block,
        throwOnError: false,
        trust: false,
        maxExpand: 1000,
        maxSize: 20,
        strict: "ignore",
      },
    );
  } catch {
    html = "";
  }
  return (
    <NodeViewWrapper
      as={block ? "div" : "span"}
      className={block ? "math-block" : "inline-math"}
      data-block-id={node.attrs.blockId}
      contentEditable={false}
    >
      <span
        className="math-render"
        role={editable ? "button" : undefined}
        tabIndex={editable ? 0 : undefined}
        aria-label={(block ? translateUI("独立公式 ") : translateUI("行内公式 ")) + node.attrs.latex}
        onClick={() => {
          if (editor.isEditable) {
            setDraft(node.attrs.latex);
            setEditing(true);
          }
        }}
        onKeyDown={(event) => {
          if (editor.isEditable && event.key === "Enter") {
            setDraft(node.attrs.latex);
            setEditing(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {editing && editable && (
        <span className="math-edit" role="group" aria-label={translateUI("编辑 LaTeX 公式")}>
          <input
            aria-label={translateUI("LaTeX 源码")}
            value={draft}
            autoFocus
            maxLength={20000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (!editor.isEditable) return;
                updateAttributes({ latex: draft });
                setEditing(false);
              }
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (!editor.isEditable) return;
              updateAttributes({ latex: draft });
              setEditing(false);
            }}
          >{translateUI("保存公式 ")}</button>
          <button type="button" onClick={() => setEditing(false)}>{translateUI("取消 ")}</button>
        </span>
      )}
    </NodeViewWrapper>
  );
}
export const MathInput = Extension.create({
  name: "simpleMathInput",
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s*([^$\n]+?)\s*\$\$$/,
        handler: ({ state, range, match }) => {
          const pos = state.doc.resolve(range.from);
          if (pos.parent.type.name !== "paragraph") return null;
          state.tr.replaceWith(
            pos.before(),
            pos.after(),
            state.schema.nodes.mathBlock.create({
              blockId: pos.parent.attrs.blockId,
              latex: match[1].trim(),
            }),
          );
        },
      }),
      new InputRule({
        find: /(?:^|[^$])\$([^$\n]+)\$$/,
        handler: ({ state, range, match }) => {
          const from = range.from + match[0].length - match[1].length - 2;
          state.tr.replaceWith(
            from,
            range.to,
            state.schema.nodes.inlineMath.create({ latex: match[1].trim() }),
          );
        },
      }),
    ];
  },
});

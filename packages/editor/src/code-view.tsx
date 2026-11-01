import { t as translateUI } from "@anote/i18n";
import React, { useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import { BlockControls, selectBlock } from "./block-controls.js";
import { useEditorEditable } from "./editable-state.js";
import { MermaidPreview } from "./mermaid-view.js";
const lowlight = createLowlight(common);
async function copyCode(value: string) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  try {
    if (!document.execCommand("copy")) throw new Error(translateUI("复制失败"));
  } finally {
    input.remove();
  }
}
lowlight.register("plaintext", () => ({ contains: [] }));
lowlight.register("mermaid", () => ({
  keywords:
    "flowchart graph LR TD TB BT RL sequenceDiagram participant classDiagram stateDiagram mindmap gantt pie",
  contains: [
    { className: "string", begin: '"', end: '"' },
    { className: "comment", begin: "%%", end: "$" },
  ],
}));
export const HighlightedCode = CodeBlockLowlight.configure({
  lowlight,
  defaultLanguage: "plaintext",
  enableTabIndentation: true,
  tabSize: 2,
});
export function CodeView({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const language = node.attrs.language || "plaintext",
    diagram = language === "mermaid";
  const editable = useEditorEditable(editor);
  const [source, setSource] = useState(!diagram || !node.textContent.trim()),
    [copied, setCopied] = useState(false);
  const languages = [
    "plaintext",
    "python",
    "javascript",
    "typescript",
    "bash",
    "json",
    "yaml",
    "xml",
    "css",
    "sql",
    "cpp",
    "c",
    "java",
    "rust",
    "go",
    "markdown",
    "mermaid",
  ];
  if (!languages.includes(language)) languages.push(language);
  return (
    <NodeViewWrapper
      className={"academic-code-block" + (diagram ? " diagram-code-block" : "") + (selected ? " is-block-selected" : "")}
      data-block-id={node.attrs.blockId}
      onMouseDown={(event: React.MouseEvent<HTMLElement>) => {
        const target = event.target as Element;
        if (editor.isEditable && !target.closest("button,input,select,textarea") && (target === event.currentTarget || target.closest(".code-block-header"))) {
          event.preventDefault(); selectBlock({ editor, getPos });
        }
      }}
    >
      <div className="code-block-header" contentEditable={false}>
        <select
          aria-label={translateUI("代码语言")}
          value={language}
          disabled={!editable}
          onChange={(event) => {
            if (!editor.isEditable) return;
            const value = event.target.value;
            updateAttributes({
              language: value === "plaintext" ? null : value,
            });
            setSource(value !== "mermaid" || !node.textContent.trim());
          }}
        >
          {languages.map((value) => (
            <option key={value} value={value}>
              {value === "plaintext" ? translateUI("纯文本") : value}
            </option>
          ))}
        </select>
        <span />
        {diagram && (
          <button type="button" onClick={() => setSource(!source)}>
            {source ? translateUI("预览图表") : translateUI("编辑源码")}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void copyCode(node.textContent)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? translateUI("已复制") : translateUI("复制代码")}
        </button>
        <BlockControls editor={editor} getPos={getPos} selected={selected} label={diagram ? translateUI("Mermaid 图表") : translateUI("代码块")}/>
      </div>
      <pre className={diagram && !source ? "code-source-hidden" : ""}>
        <NodeViewContent<"code"> as="code" className={"language-" + language} />
      </pre>
      {diagram && !source && <MermaidPreview code={node.textContent} onSelect={editable ? () => selectBlock({ editor, getPos }) : undefined} />}
    </NodeViewWrapper>
  );
}

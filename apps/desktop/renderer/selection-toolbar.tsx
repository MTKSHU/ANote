import { t as translateUI } from "@anote/i18n";
import React, { useState } from "react";
import type { Editor } from "@tiptap/core";
import { FONT_SIZES } from "@anote/document-model";
import { Icon } from "./icons";
const colors = [
  [translateUI("默认黑"), "#242833"],
  [translateUI("灰色"), "#6b7280"],
  [translateUI("红色"), "#dc2626"],
  [translateUI("橙色"), "#ea580c"],
  [translateUI("黄色"), "#ca8a04"],
  [translateUI("绿色"), "#15803d"],
  [translateUI("蓝色"), "#2563eb"],
  [translateUI("紫色"), "#7c3aed"],
];
const highlights = [
  [translateUI("灰色"), "#f1f3f5"],
  [translateUI("红色"), "#fee2e2"],
  [translateUI("橙色"), "#ffedd5"],
  [translateUI("黄色"), "#fef08a"],
  [translateUI("绿色"), "#dcfce7"],
  [translateUI("蓝色"), "#dbeafe"],
  [translateUI("紫色"), "#ede9fe"],
  [translateUI("粉色"), "#fce7f3"],
];
export function SelectionToolbar({
  editor,
  onComment,
  preserveScroll = false,
}: {
  editor: Editor;
  onComment?: () => void;
  preserveScroll?: boolean;
}) {
  const [menu, setMenu] = useState(""),
    [custom, setCustom] = useState("#2563eb");
  const attrs = editor.getAttributes("textStyle");
  const alignment =
    editor.getAttributes(editor.isActive("heading") ? "heading" : "paragraph")
      .textAlign || "left";
  function toggle(next: string) {
    setMenu(menu === next ? "" : next);
    if (next === "color" || next === "highlight")
      setCustom(
        attrs[next === "color" ? "color" : "backgroundColor"] ||
          (next === "color" ? "#2563eb" : "#fef08a"),
      );
  }
  function style(value: {
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
  }) {
    editor
      .chain()
      .focus(null, { scrollIntoView: !preserveScroll })
      .setAcademicTextStyle(value)
      .run();
    setMenu("");
  }
  const expanded = (id: string) => ({
    "aria-expanded": menu === id,
    "aria-haspopup": "dialog" as const,
  });
  const canStyle = editor.can().setAcademicTextStyle({ fontSize: 16 });
  return (
    <div
      className="selection-toolbar"
      role="toolbar"
      aria-label={translateUI("选区格式")}
      onKeyDownCapture={(e) => {
        if (e.key === "Escape" && menu) {
          e.preventDefault();
          e.stopPropagation();
          setMenu("");
          editor.commands.focus(null, { scrollIntoView: !preserveScroll });
        }
      }}
    >
      <button
        className="font-size-trigger"
        aria-label={translateUI("字号")}
        title={translateUI("字号")}
        {...expanded("size")}
        disabled={!canStyle}
        onClick={() => toggle("size")}
      >
        <span>{attrs.fontSize || translateUI("字号")}</span>
        <Icon name="down" size={11} />
      </button>
      <i />
      <button
        aria-label={translateUI("加粗")}
        title={translateUI("加粗")}
        aria-pressed={editor.isActive("bold")}
        onClick={() =>
          editor
            .chain()
            .focus(null, { scrollIntoView: !preserveScroll })
            .toggleBold()
            .run()
        }
      >
        <b>B</b>
      </button>
      <button
        aria-label={translateUI("斜体")}
        title={translateUI("斜体")}
        aria-pressed={editor.isActive("italic")}
        onClick={() =>
          editor
            .chain()
            .focus(null, { scrollIntoView: !preserveScroll })
            .toggleItalic()
            .run()
        }
      >
        <em>I</em>
      </button>
      <button
        aria-label={translateUI("删除线")}
        title={translateUI("删除线")}
        aria-pressed={editor.isActive("strike")}
        onClick={() =>
          editor
            .chain()
            .focus(null, { scrollIntoView: !preserveScroll })
            .toggleStrike()
            .run()
        }
      >
        <s>S</s>
      </button>
      <i />
      <button
        aria-label={translateUI("文字颜色")}
        title={translateUI("文字颜色")}
        {...expanded("color")}
        disabled={!canStyle}
        onClick={() => toggle("color")}
      >
        <span
          className="text-color-glyph"
          style={{ borderColor: attrs.color || "#36445a" }}
        >
          A
        </span>
        <Icon name="down" size={10} />
      </button>
      <button
        aria-label={translateUI("背景颜色")}
        title={translateUI("背景颜色（文字高亮）")}
        {...expanded("highlight")}
        disabled={!canStyle}
        onClick={() => toggle("highlight")}
      >
        <span
          className="highlight-color-glyph"
          style={{ borderColor: attrs.backgroundColor || "#fef08a" }}
        >
          <Icon name="highlighter" size={17} />
        </span>
        <Icon name="down" size={10} />
      </button>
      <i />
      <button
        aria-label={translateUI("对齐")}
        title={translateUI("段落对齐")}
        {...expanded("align")}
        onClick={() => toggle("align")}
      >
        <Icon name={alignment} size={17} />
        <Icon name="down" size={10} />
      </button>
      <i />
      <button
        aria-label={translateUI("清除格式")}
        title={translateUI("清除选中文字格式，保留段落结构")}
        onClick={() => {
          editor
            .chain()
            .focus(null, { scrollIntoView: !preserveScroll })
            .unsetAllMarks()
            .run();
          setMenu("");
        }}
      >
        <Icon name="clear-format" size={18} />
      </button>
      {onComment && (
        <>
          <i />
          <button
            aria-label={translateUI("添加批注")}
            title={translateUI("添加批注（Ctrl / ⌘ + Alt + M）")}
            onClick={onComment}
          >
            <Icon name="comment" size={17} />
          </button>
        </>
      )}
      {menu === "size" && (
        <div
          className="format-popover font-size-options"
          role="dialog"
          aria-label={translateUI("字号设置")}
        >
          <h4>{translateUI("字号")}</h4>
          <button onClick={() => style({ fontSize: undefined })}>{translateUI("默认字号 ")}</button>
          {FONT_SIZES.map((n) => (
            <button
              key={n}
              aria-pressed={attrs.fontSize === n}
              onClick={() => style({ fontSize: n })}
            >
              {n} px{attrs.fontSize === n && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
      {menu === "align" && (
        <div
          className="format-popover alignment-options"
          role="dialog"
          aria-label={translateUI("对齐设置")}
        >
          <h4>{translateUI("段落对齐")}</h4>
          {[
            ["left", translateUI("左对齐")],
            ["center", translateUI("居中对齐")],
            ["right", translateUI("右对齐")],
            ["justify", translateUI("两端对齐")],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={alignment === value}
              onClick={() => {
                editor
                  .chain()
                  .focus(null, { scrollIntoView: !preserveScroll })
                  .setTextAlign(value)
                  .run();
                setMenu("");
              }}
            >
              <Icon name={value} size={17} />
              {label}
            </button>
          ))}
        </div>
      )}
      {(menu === "color" || menu === "highlight") && (
        <div
          className="format-popover color-options"
          role="dialog"
          aria-label={menu === "color" ? translateUI("文字颜色设置") : translateUI("背景颜色设置")}
        >
          <h4>{menu === "color" ? translateUI("文字颜色") : translateUI("背景颜色")}</h4>
          <button
            className="reset-inline-style"
            onClick={() =>
              style(
                menu === "color"
                  ? { color: undefined }
                  : { backgroundColor: undefined },
              )
            }
          >
            {menu === "color" ? translateUI("默认文字颜色") : translateUI("无背景颜色")}
          </button>
          <div className="color-swatches">
            {(menu === "color" ? colors : highlights).map(([label, value]) => (
              <button
                key={value}
                className="color-swatch"
                aria-label={(menu === "color" ? translateUI("文字色 ") : translateUI("背景色 ")) + label}
                title={label + " " + value}
                aria-pressed={
                  attrs[menu === "color" ? "color" : "backgroundColor"] ===
                  value
                }
                style={{ backgroundColor: value }}
                onClick={() =>
                  style(
                    menu === "color"
                      ? { color: value }
                      : { backgroundColor: value },
                  )
                }
              >
                {attrs[menu === "color" ? "color" : "backgroundColor"] ===
                  value && <Icon name="check" size={13} />}
              </button>
            ))}
          </div>
          <div className="custom-color-row">
            <input
              type="color"
              aria-label={
                menu === "color" ? translateUI("自定义文字颜色") : translateUI("自定义背景颜色")
              }
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <input
              className="custom-color-text"
              aria-label={translateUI("颜色值")}
              value={custom}
              maxLength={7}
              onChange={(e) => setCustom(e.target.value)}
            />
            <button
              disabled={!/^#[0-9a-f]{6}$/i.test(custom)}
              onClick={() =>
                style(
                  menu === "color"
                    ? { color: custom.toLowerCase() }
                    : { backgroundColor: custom.toLowerCase() },
                )
              }
            >{translateUI("应用 ")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
type TableCommand =
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "mergeCells"
  | "splitCell";
export function TableToolbar({ editor }: { editor: Editor }) {
  const commands: Array<{
    id: TableCommand;
    icon: string;
    label: string;
    danger?: boolean;
  }> = [
    { id: "addRowBefore", icon: "row-before", label: translateUI("在上方插入行") },
    { id: "addRowAfter", icon: "row-after", label: translateUI("在下方插入行") },
    { id: "deleteRow", icon: "row-delete", label: translateUI("删除行"), danger: true },
    { id: "addColumnBefore", icon: "column-before", label: translateUI("在左侧插入列") },
    { id: "addColumnAfter", icon: "column-after", label: translateUI("在右侧插入列") },
    {
      id: "deleteColumn",
      icon: "column-delete",
      label: translateUI("删除列"),
      danger: true,
    },
    { id: "mergeCells", icon: "cells-merge", label: translateUI("合并单元格") },
    { id: "splitCell", icon: "cells-split", label: translateUI("拆分单元格") },
  ];
  return (
    <div className="table-icon-toolbar" role="toolbar" aria-label={translateUI("表格操作")}>
      {commands.map((c, i) => (
        <React.Fragment key={c.id}>
          {[3, 6].includes(i) && <i />}
          <button
            className={c.danger ? "table-danger" : ""}
            aria-label={c.label}
            title={c.label}
            disabled={!editor.can()[c.id]()}
            onClick={() =>
              editor
                .chain()
                .focus(null, { scrollIntoView: false })
                [c.id]()
                .run()
            }
          >
            <Icon name={c.icon} size={19} />
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

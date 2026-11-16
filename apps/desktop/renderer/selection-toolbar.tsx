import { t as translateUI } from "@anote/i18n";
import React, { useState } from "react";
import type { Editor } from "@tiptap/core";
import { FONT_SIZES } from "@anote/document-model";
import {yUndoPluginKey} from "@tiptap/y-tiptap";
import { Icon } from "./icons";
import {adjustTableColumns} from './table-widths';
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
  onNoteLink,
  preserveScroll = false,
}: {
  editor: Editor;
  onComment?: () => void;
  onNoteLink?:()=>void;
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
      <button aria-label={translateUI("首行缩进")} title={translateUI("段落首行缩进")} {...expanded("indent")}
        disabled={!editor.can().setFirstLineIndent(2)} onClick={() => toggle("indent")}>
        <Icon name="first-line-indent" size={17}/><Icon name="down" size={10}/>
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
      {onNoteLink&&<button type="button" aria-label={translateUI("笔记链接")} title={translateUI("链接到其他笔记（Ctrl / ⌘ + K）")} onClick={onNoteLink}><Icon name="file" size={17}/></button>}
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
      {menu === "indent" && <div className="format-popover alignment-options" role="dialog" aria-label={translateUI("首行缩进设置")}>
        <h4>{translateUI("首行缩进")}</h4>
        {([2, null] as const).map(value => <button key={value ?? "none"}
          aria-pressed={(editor.getAttributes("paragraph").firstLineIndent === 2) === (value === 2)}
          onClick={() => {
            const undo = yUndoPluginKey.getState(editor.state)?.undoManager; undo?.stopCapturing();
            editor.chain().focus(null, {scrollIntoView: !preserveScroll}).setFirstLineIndent(value).run();
            undo?.stopCapturing(); setMenu("");
          }}>{value === 2 ? translateUI("首行缩进 2 字符") : translateUI("取消首行缩进")}</button>)}
      </div>}
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
  const [colorOpen,setColorOpen]=useState(false),[verticalOpen,setVerticalOpen]=useState(false),[custom,setCustom]=useState("#dbeafe");
  const background=editor.getAttributes(editor.isActive("tableHeader")?"tableHeader":"tableCell").background;
  const vertical=editor.getAttributes(editor.isActive("tableHeader")?"tableHeader":"tableCell").verticalAlign||"top";
  function align(value:string){
    const undo=yUndoPluginKey.getState(editor.state)?.undoManager;undo?.stopCapturing();
    editor.chain().focus(null,{scrollIntoView:false}).setCellAttribute("verticalAlign",value).run();
    undo?.stopCapturing();setVerticalOpen(false);
  }
  function fill(value:string|null){
    const undo=yUndoPluginKey.getState(editor.state)?.undoManager;
    undo?.stopCapturing();
    editor.chain().focus(null,{scrollIntoView:false}).setCellAttribute("background",value).run();
    undo?.stopCapturing();
    setColorOpen(false);
  }
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
    <div className="table-icon-toolbar" role="toolbar" aria-label={translateUI("表格操作")} onKeyDownCapture={event=>{
      if(event.key==="Escape"&&(colorOpen||verticalOpen)){event.preventDefault();event.stopPropagation();setColorOpen(false);setVerticalOpen(false);editor.commands.focus(null,{scrollIntoView:false});}
    }}>
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
      <i />
      <button aria-label={translateUI("按内容调整列宽")} title={translateUI("按整张表格的内容调整列宽，长文字自动换行")} disabled={!editor.isEditable} onClick={()=>adjustTableColumns(editor,'content')}><Icon name="columns-fit" size={19}/></button>
      <button aria-label={translateUI("平均分配列宽")} title={translateUI("将整张表格的列宽平均分配到可用页面宽度")} disabled={!editor.isEditable} onClick={()=>adjustTableColumns(editor,'equal')}><Icon name="columns-equal" size={19}/></button>
      <i />
      <button aria-label={translateUI("单元格垂直对齐")} title={translateUI("单元格垂直对齐")} aria-expanded={verticalOpen} aria-haspopup="dialog" disabled={!editor.isEditable} onClick={()=>{setColorOpen(false);setVerticalOpen(value=>!value);}}>
        <Icon name={"vertical-"+vertical} size={19}/><Icon name="down" size={10}/>
      </button>
      {verticalOpen&&<div className="format-popover alignment-options" role="dialog" aria-label={translateUI("单元格垂直对齐设置")}><h4>{translateUI("垂直对齐")}</h4>
        {[["top",translateUI("顶部对齐")],["middle",translateUI("垂直居中")],["bottom",translateUI("底部对齐")]].map(([value,label])=><button key={value} aria-pressed={vertical===value} onClick={()=>align(value)}><Icon name={"vertical-"+value} size={17}/>{label}</button>)}
      </div>}
      <button aria-label={translateUI("单元格底纹")} title={translateUI("设置所选单元格的底纹颜色")} aria-expanded={colorOpen} aria-haspopup="dialog" disabled={!editor.isEditable} onClick={()=>{setVerticalOpen(false);setCustom(/^#[0-9a-f]{6}$/i.test(background||"")?background:"#dbeafe");setColorOpen(value=>!value);}}>
        <span className="table-cell-color-glyph" style={{borderColor:background||"var(--line)"}}><Icon name="highlighter" size={18}/></span><Icon name="down" size={10}/>
      </button>
      {colorOpen&&<div className="format-popover color-options table-cell-color-options" role="dialog" aria-label={translateUI("单元格底纹设置")}>
        <h4>{translateUI("单元格底纹")}</h4>
        <button className="reset-inline-style" onClick={()=>fill(null)}>{translateUI("无底纹颜色")}</button>
        <div className="color-swatches">{highlights.map(([label,value])=><button key={value} className="color-swatch" aria-label={translateUI("底纹色 {0}", [label])} title={label+" "+value} aria-pressed={background===value} style={{backgroundColor:value}} onClick={()=>fill(value)}>{background===value&&<Icon name="check" size={13}/>}</button>)}</div>
        <div className="custom-color-row">
          <input type="color" aria-label={translateUI("自定义底纹颜色")} value={/^#[0-9a-f]{6}$/i.test(custom)?custom:"#dbeafe"} onChange={event=>setCustom(event.target.value)}/>
          <input className="custom-color-text" aria-label={translateUI("底纹颜色值")} value={custom} maxLength={7} onChange={event=>setCustom(event.target.value)}/>
          <button disabled={!/^#[0-9a-f]{6}$/i.test(custom)} onClick={()=>fill(custom.toLowerCase())}>{translateUI("应用底纹")}</button>
        </div>
      </div>}
    </div>
  );
}

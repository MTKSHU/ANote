import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { SelectionToolbar } from "./selection-toolbar";
import { Icon } from "./icons";
import { TableControls } from "./table-controls";
import { uploadTypes, type UploadCategory } from "./upload-types";
import { newId } from "@anote/document-model/id";
type Position = { left: number; top: number };
type Slash = Position & { from: number; to: number; query: string };
type Action = {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  icon: string;
  run: (e: Editor) => void;
  online?: boolean;
};
export function EditorTools({
  editor,
  onUpload,
  offline,
  onComment,
}: {
  editor: Editor;
  onUpload: (category: UploadCategory) => void;
  offline: boolean;
  onComment?: () => void;
}) {
  const [slash, setSlash] = useState<Slash | null>(null),
    [bubble, setBubble] = useState<(Position & { text: boolean }) | null>(null),
    [index, setIndex] = useState(0);
  const config = useRef({ onUpload, offline });
  config.current = { onUpload, offline };
  const current = useRef<Slash | null>(null),
    activeIndex = useRef(0),
    dismissed = useRef(""),
    actionsRef = useRef<Action[]>([]);
  const actions: Action[] = [
    ...[1, 2, 3, 4, 5].map((level) => ({
      id: "h" + level,
      label: translateUI("标题 {0}", [level]),
      hint: "H" + level,
      keywords: translateUI("h{0} heading {1} 标题{2}", [level, level, level]),
      icon: "file",
      run: (e: Editor) => {
        e.chain()
          .focus()
          .setHeading({ level: level as 1 | 2 | 3 | 4 | 5 })
          .run();
      },
    })),
    {
      id: "paragraph",
      label: translateUI("正文"),
      hint: translateUI("普通文本"),
      keywords: "text paragraph 正文 文本",
      icon: "file",
      run: (e) => {
        e.chain().focus().clearNodes().setParagraph().run();
      },
    },
    {
      id: "ordered",
      label: translateUI("有序编号"),
      hint: translateUI("按顺序组织内容"),
      keywords: "ordered number 有序 编号 列表",
      icon: "ordered",
      run: (e) => {
        e.chain().focus().toggleOrderedList().run();
      },
    },
    {
      id: "bullet",
      label: translateUI("无序编号"),
      hint: translateUI("项目列表"),
      keywords: "bullet list 无序 项目 列表",
      icon: "list",
      run: (e) => {
        e.chain().focus().toggleBulletList().run();
      },
    },
    {
      id: "todo",
      label: translateUI("待办事项"),
      hint: translateUI("- [ ] 未完成，- [x] 已完成"),
      keywords: "todo task checkbox 待办 代办 任务 勾选",
      icon: "list",
      run: e=>{e.chain().focus().toggleTaskList().run();},
    },
    {
      id: "quote",
      label: translateUI("引用"),
      hint: translateUI("引用一段文字"),
      keywords: "quote 引用",
      icon: "quote",
      run: (e) => {
        e.chain().focus().toggleBlockquote().run();
      },
    },
    {
      id: "code",
      label: translateUI("代码块"),
      hint: translateUI("代码、命令与 Mermaid 图表，插入后选择语言"),
      keywords: "code 代码 命令 diagram mermaid 流程图 时序图",
      icon: "code",
      run: (e) => {
        e.chain().focus().toggleCodeBlock().run();
      },
    },
    {
      id: "table",
      label: translateUI("表格"),
      hint: translateUI("插入 3 × 3 表格"),
      keywords: "table 表格",
      icon: "table",
      run: (e) => {
        e.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
      },
    },
    ...Object.entries(uploadTypes).map(([category, value]) => ({
      id: "upload-" + category,
      label: value.label,
      hint: value.hint,
      keywords:
        translateUI("upload 上传 {0}{1}", [category, (category === "project" ? translateUI(" 3d blender unity ue 三维 项目") : "")]),
      icon:
        category === "image" || category === "comparison"
          ? "image"
          : "attachment",
      online: true,
      run: () => config.current.onUpload(category as UploadCategory),
    })),
    {
      id: "mindmap",
      label: translateUI("思维导图"),
      hint: translateUI("拖动节点、增删分支与修改文字"),
      keywords: "mindmap 思维 脑图",
      icon: "table",
      run: (e) => {
        e.chain()
          .focus()
          .insertContent([
            {
              type: "mindMap",
              content: [
                {
                  type: "mindMapItem",
                  attrs: { id: newId(), parentId: null, x: 320, y: 180 },
                  content: [{ type: "text", text: translateUI("中心主题") }],
                },
              ],
            },
            { type: "paragraph" },
          ])
          .run();
      },
    },
    {
      id: "formula",
      label: translateUI("LaTeX 公式"),
      hint: translateUI("独立公式，也可输入 $$…$$ 或 $…$"),
      keywords: "latex math formula 公式 数学",
      icon: "code",
      run: (e) => {
        e.chain()
          .focus()
          .insertContent([
            { type: "mathBlock", attrs: { latex: "X_t" } },
            { type: "paragraph" },
          ])
          .run();
      },
    },
    {
      id: "divider",
      label: translateUI("分隔线"),
      hint: translateUI("分开不同段落"),
      keywords: "divider 分隔线",
      icon: "divider",
      run: (e) => {
        e.chain().focus().setHorizontalRule().run();
      },
    },
  ];
  const filtered = actions.filter(
    (a) =>
      !slash?.query ||
      [a.label, a.keywords, a.hint]
        .join(" ")
        .toLowerCase()
        .includes(slash.query.trim().toLowerCase()),
  );
  actionsRef.current = filtered;
  function choose(action: Action) {
    const range = current.current;
    if (!range || (action.online && config.current.offline)) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: range.from, to: range.to })
      .run();
    current.current = null;
    setSlash(null);
    setIndex(0);
    action.run(editor);
  }
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    const dom = editor.view.dom;
    let frame = 0;
    const update = () => {
      if (editor.isDestroyed || !dom.isConnected) return;
      dom.dataset.empty = String(editor.isEmpty);
      const { selection } = editor.state,
        { $from, from, to } = selection;
      if (!editor.isEditable) {
        current.current = null;
        setSlash(null);
        setBubble(null);
        return;
      }
      if (
        (document.activeElement as Element | null)?.closest(
          ".academic-floating-tools",
        )
      )
        return;
      const focused =
        dom.contains(document.activeElement) || document.activeElement === dom;
      const prefix = $from.parent.textBetween(
          0,
          $from.parentOffset,
          "\n",
          "\ufffc",
        ),
        match =
          !editor.isActive("codeBlock") &&
          selection.empty &&
          focused &&
          !prefix.split(/\s/).at(-1)?.includes("://")
            ? /^\/([^/\n]{0,32})$/.exec(prefix)
            : null;
      if (match) {
        const start = from - match[1].length - 1,
          key = start + ":" + from;
        if (dismissed.current !== key) {
          const point = editor.view.coordsAtPos(from),
            next = {
              from: start,
              to: from,
              query: match[1],
              left: Math.max(12, Math.min(point.left, innerWidth - 312)),
              top: Math.max(12, Math.min(point.bottom + 8, innerHeight - 370)),
            };
          if (current.current?.query !== next.query) {
            activeIndex.current = 0;
            setIndex(0);
          }
          current.current = next;
          setSlash(next);
          setBubble(null);
          return;
        }
      }
      current.current = null;
      setSlash(null);
      if (editor.isActive("table")) {
        setBubble(null);
        return;
      }
      const text =
        !(selection instanceof NodeSelection) &&
        !selection.empty &&
        !!editor.state.doc.textBetween(from, to, " ").trim();
      const nativeSelection = window.getSelection();
      const inEditor =
        !!nativeSelection?.anchorNode &&
        dom.contains(nativeSelection.anchorNode);
      if (focused && inEditor && text) {
        const rect = nativeSelection?.rangeCount
            ? nativeSelection.getRangeAt(0).getBoundingClientRect()
            : null,
          point = editor.view.coordsAtPos(from),
          left = rect?.width ? rect.left : point.left,
          top = rect?.height ? rect.top : point.top;
        setBubble({
          text,
          left: Math.max(12, Math.min(left, innerWidth - 470)),
          top: Math.max(12, top - 48),
        });
      } else setBubble(null);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const keydown = (e: KeyboardEvent) => {
      if (!current.current || editor.view.composing || e.isComposing) return;
      if (e.key === "Escape") {
        dismissed.current = current.current.from + ":" + current.current.to;
        current.current = null;
        setSlash(null);
        e.preventDefault();
        e.stopPropagation();
      } else if (
        ["ArrowDown", "ArrowUp", "Enter"].includes(e.key) &&
        actionsRef.current.length
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter")
          chooseRef.current(
            actionsRef.current[activeIndex.current % actionsRef.current.length],
          );
        else {
          activeIndex.current =
            (activeIndex.current +
              (e.key === "ArrowDown" ? 1 : -1) +
              actionsRef.current.length) %
            actionsRef.current.length;
          setIndex(activeIndex.current);
        }
      }
    };
    const outside = (e: PointerEvent) => {
      if (
        !(e.target as Element).closest?.(
          ".academic-floating-tools,.academic-slash-menu",
        ) &&
        !dom.contains(e.target as Node)
      ) {
        setBubble(null);
        setSlash(null);
        current.current = null;
      }
    };
    editor.on("transaction", schedule);
    dom.addEventListener("keydown", keydown, true);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", schedule);
      dom.removeEventListener("keydown", keydown, true);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [editor]);
  useEffect(() => {
    document
      .getElementById("academic-command-" + index)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <>
      <TableControls editor={editor} onComment={onComment} offline={offline} />
      {slash && (
        <div
          className="academic-slash-menu"
          role="listbox"
          aria-label={translateUI("插入内容")}
          style={{ left: slash.left, top: slash.top }}
        >
          <div className="command-heading">{translateUI("插入内容 ")}<kbd>↑ ↓</kbd>
            <kbd>Enter</kbd>
          </div>
          {filtered.map((a, i) => (
            <button
              key={a.id}
              id={"academic-command-" + i}
              role="option"
              aria-selected={index === i}
              disabled={a.online && offline}
              className={index === i ? "active" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => {
                activeIndex.current = i;
                setIndex(i);
              }}
              onClick={() => choose(a)}
            >
              <span className="command-icon">
                {a.id.startsWith("h") ? (
                  <b>{a.hint}</b>
                ) : (
                  <Icon name={a.icon} />
                )}
              </span>
              <span>
                <strong>{a.label}</strong>
                <small>{a.online && offline ? translateUI("联网后可插入") : a.hint}</small>
              </span>
            </button>
          ))}
          {!filtered.length && <p>{translateUI("没有匹配的内容")}</p>}
        </div>
      )}
      {bubble && (
        <div
          className="academic-floating-tools"
          role="group"
          aria-label={translateUI("编辑工具")}
          style={{ left: bubble.left, top: bubble.top }}
          onMouseDown={(e) => {
            if (!(e.target as Element).closest("input,select"))
              e.preventDefault();
          }}
        >
          {bubble.text && (
            <SelectionToolbar
              editor={editor}
              onComment={offline ? undefined : onComment}
            />
          )}
        </div>
      )}
    </>
  );
}

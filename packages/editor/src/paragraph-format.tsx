import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
type Target = { pos: number; id: string | null };
type Position = Target & { left: number; top: number; level: number; allowed: boolean[] };
export function ParagraphFormat({ editor }: { editor: Editor }) {
  const [position, setPosition] = useState<Position | null>(null), [open, setOpen] = useState(false);
  const opened = useRef(false), target = useRef<Target | null>(null), control = useRef<HTMLDivElement>(null);
  function close(focus = false) { opened.current = false; setOpen(false); if (focus) editor.commands.focus(); }
  function permitted(pos: number, level: number) {
    const point = editor.state.doc.resolve(pos), type = editor.schema.nodes[level ? "heading" : "paragraph"];
    return point.parent.canReplaceWith(point.index(), point.index() + 1, type);
  }
  useEffect(() => {
    let frame = 0;
    const editorDom = editor.view.dom;
    const update = () => {
      if (editor.isDestroyed || !editor.isEditable || editor.view.composing || (!editor.view.hasFocus() && !control.current?.contains(document.activeElement))) { setPosition(null); close(); return; }
      let current: Target | null = opened.current ? target.current : null;
      if (!current) {
        const { $from } = editor.state.selection;
        if (["paragraph", "heading"].includes($from.parent.type.name)) current = { pos: $from.before($from.depth), id: $from.parent.attrs.blockId || null };
      }
      if (!current) { setPosition(null); close(); return; }
      const node = editor.state.doc.nodeAt(current.pos), dom = editor.view.nodeDOM(current.pos);
      if (!node || !["paragraph", "heading"].includes(node.type.name) || !(dom instanceof HTMLElement)) { setPosition(null); close(); return; }
      const box = dom.getBoundingClientRect(), root = editor.view.dom.getBoundingClientRect(),
        lineHeight = Number.parseFloat(getComputedStyle(dom).lineHeight) || 24,
        left = Math.max(4, root.left + (Number.parseFloat(getComputedStyle(editor.view.dom).paddingLeft) || 36) - 34),
        top = box.top + Math.min(box.height || lineHeight, lineHeight) / 2 - 12;
      let clipTop = 0, clipBottom = window.innerHeight;
      for (let parent = dom.parentElement; parent; parent = parent.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) { const rect = parent.getBoundingClientRect(); clipTop = Math.max(clipTop, rect.top); clipBottom = Math.min(clipBottom, rect.bottom); }
      if (top < clipTop || top + 24 > clipBottom || left + 28 > window.innerWidth) { setPosition(null); return; }
      const hit = document.elementFromPoint(left + 14, top + 12);
      if (hit && !editor.view.dom.contains(hit) && !control.current?.contains(hit)) { setPosition(null); return; }
      target.current = current;
      setPosition({ ...current, left, top, level: node.type.name === "heading" ? node.attrs.level : 0, allowed: Array.from({ length: 6 }, (_, level) => permitted(current!.pos, level)) });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const transaction = ({ transaction }: any) => {
      if (opened.current && target.current) {
        const mapped = transaction.mapping.mapResult(target.current.pos);
        if (mapped.deleted) close(); else target.current.pos = mapped.pos;
      }
      schedule();
    };
    const outside = (event: PointerEvent) => { if (!control.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (opened.current && event.key === "Escape" && !event.isComposing && !editor.view.composing) { event.preventDefault(); event.stopPropagation(); close(true); } };
    editor.on("transaction", transaction); editor.on("selectionUpdate", schedule); editor.on("focus", schedule); editor.on("blur", schedule); editor.on("update", schedule);
    editorDom.addEventListener("compositionend", schedule); window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule); document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true); schedule();
    return () => { cancelAnimationFrame(frame); editor.off("transaction", transaction); editor.off("selectionUpdate", schedule); editor.off("focus", schedule); editor.off("blur", schedule); editor.off("update", schedule); editorDom.removeEventListener("compositionend", schedule); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [editor]);
  function toggle() {
    if (opened.current) { close(true); return; }
    opened.current = true; setOpen(true);
    requestAnimationFrame(() => control.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus());
  }
  function apply(level: number) {
    let current = target.current; if (!current || !editor.isEditable) return;
    if (current.id) {
      const id = current.id, found = { pos: -1 };
      editor.state.doc.descendants((node, pos) => { if (node.attrs.blockId === id) found.pos = pos; });
      if (found.pos < 0) { close(); return; }
      current = { pos: found.pos, id };
    }
    const node = editor.state.doc.nodeAt(current.pos); if (!node || !["paragraph", "heading"].includes(node.type.name) || !permitted(current.pos, level)) { close(); return; }
    const type = editor.schema.nodes[level ? "heading" : "paragraph"], attrs = { ...node.attrs, ...(level ? { level } : {}) }, undo = yUndoPluginKey.getState(editor.state)?.undoManager;
    undo?.stopCapturing(); editor.view.dispatch(editor.state.tr.setNodeMarkup(current.pos, type, attrs)); undo?.stopCapturing(); close(true);
  }
  if (!position || !editor.isEditable) return null;
  const menuTop = position.top + 226 < window.innerHeight ? 28 : -220;
  return createPortal(<div ref={control} className="paragraph-format-control" style={{ left: position.left, top: position.top }} onMouseDown={event => event.preventDefault()}>
    <button type="button" className="paragraph-format-trigger" aria-label={translateUI("段落格式：{0}", [(position.level ? translateUI("标题 {0}", [position.level]) : translateUI("正文"))])} aria-haspopup="menu" aria-expanded={open} title={translateUI("切换正文／标题级别")} onClick={toggle} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); if (!opened.current) toggle(); } }}>{position.level ? "H" + position.level : translateUI("正文")}</button>
    {open && <div className="paragraph-format-menu" role="menu" aria-label={translateUI("段落格式")} style={{ top: menuTop }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')), index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    }}>
      {Array.from({ length: 6 }, (_, level) => <button key={level} type="button" role="menuitemradio" aria-label={level ? translateUI("标题 {0}", [level]) : translateUI("正文")} aria-checked={position.level === level} disabled={!position.allowed[level]} onClick={() => apply(level)}><span aria-hidden="true">{level ? "H" + level : "¶"}</span>{level ? translateUI("标题 {0}", [level]) : translateUI("正文")}</button>)}
    </div>}
  </div>, document.body);
}

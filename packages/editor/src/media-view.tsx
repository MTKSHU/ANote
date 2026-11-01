import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEditorEditable } from "./editable-state.js";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
const clamp = (value: number) => Math.round(Math.max(5, Math.min(100, value)) * 10) / 10;
const corners = ["nw", "ne", "sw", "se"] as const;

export function MediaView({ node, editor, getPos, selected, updateAttributes }: NodeViewProps) {
  const a = node.attrs, editable = useEditorEditable(editor), visual = ["image", "video"].includes(a.kind),
    active = editable && selected && visual, alignment = ["left", "center", "right"].includes(a.alignment) ? a.alignment : "center",
    savedWidth = typeof a.widthPercent === "number" && Number.isFinite(a.widthPercent) ? clamp(a.widthPercent) : null;
  const root = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null),
    gesture = useRef<{ pointer: number; x: number; y: number; width: number; parent: number; ratio: number; sx: number; sy: number } | null>(null),
    previewWidth = useRef<number | null>(null);
  const [width, setWidth] = useState<number | null>(null), [toolbarLeft, setToolbarLeft] = useState(0);
  const canPreview = !!a.assetId && !String(a.src).startsWith("/api/public/");
  const preview = () => window.dispatchEvent(new CustomEvent("anote-preview-asset", { detail: a.assetId }));
  const media = () => window.dispatchEvent(new CustomEvent("anote-preview-media", { detail: { src: a.src, kind: a.kind, title: a.title, mime: a.mime } }));
  function select() {
    const pos = getPos(); if (!editor.isEditable || typeof pos !== "number") return;
    editor.commands.setNodeSelection(pos); editor.view.focus();
  }
  function format(attrs: { widthPercent?: number | null; alignment?: string }) {
    if (!editor.isEditable) return;
    const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
    undo?.stopCapturing(); updateAttributes(attrs); undo?.stopCapturing();
  }
  function cancel() { gesture.current = null; previewWidth.current = null; setWidth(null); }
  useEffect(() => { if (!editable) cancel(); }, [editable]);
  useEffect(() => {
    if (!active || !root.current || !frame.current) return;
    const place = () => {
      const box = root.current!.getBoundingClientRect(), mediaBox = frame.current!.getBoundingClientRect();
      setToolbarLeft(Math.max(0, Math.min(mediaBox.left - box.left, box.width - 280)));
    };
    const observer = new ResizeObserver(place); observer.observe(root.current); observer.observe(frame.current); place();
    return () => observer.disconnect();
  }, [active, alignment, savedWidth]);
  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); media(); }
    else if (event.key === " ") { event.preventDefault(); event.stopPropagation(); editable ? select() : media(); }
  }
  function resize(event: React.PointerEvent<HTMLButtonElement>, corner: typeof corners[number]) {
    if (event.button !== 0 || !editor.isEditable) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const box = frame.current!.getBoundingClientRect(), parent = root.current!.getBoundingClientRect();
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: box.width, parent: parent.width, ratio: box.width / Math.max(1, box.height), sx: corner.endsWith("e") ? 1 : -1, sy: corner.startsWith("s") ? 1 : -1 };
    previewWidth.current = savedWidth; event.currentTarget.setPointerCapture(event.pointerId);
  }
  return <NodeViewWrapper ref={root} className={"media-resource" + (active ? " is-media-selected" : "")} data-block-id={a.blockId} data-media-kind={a.kind} contentEditable={false}>
    {visual ? <>
      {active && <div className="media-format-tools" role="group" aria-label={translateUI("媒体排版")} style={{ left: toolbarLeft }} onMouseDown={event => { if (!(event.target as Element).closest("select")) event.preventDefault(); }}>
        {(["left", "center", "right"] as const).map((value, index) => <button type="button" key={value} aria-label={translateUI("媒体{0}", [[translateUI("左对齐"), translateUI("居中对齐"), translateUI("右对齐")][index]])} aria-pressed={alignment === value} title={[translateUI("左对齐"), translateUI("居中对齐"), translateUI("右对齐")][index]} onClick={() => format({ alignment: value })}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={value === "left" ? "M3 5h18M3 10h12M3 15h18M3 20h12" : value === "right" ? "M3 5h18M9 10h12M3 15h18M9 20h12" : "M3 5h18M6 10h12M3 15h18M6 20h12"}/></svg>
        </button>)}
        <select aria-label={translateUI("媒体宽度")} value={savedWidth == null ? "auto" : String(savedWidth)} onChange={event => format({ widthPercent: event.target.value === "auto" ? null : Number(event.target.value) })}>
          <option value="auto">{translateUI("原始大小")}</option>
          {savedWidth != null && ![25, 50, 75, 100].includes(savedWidth) && <option value={savedWidth}>{savedWidth}%</option>}
          {[25, 50, 75, 100].map(value => <option key={value} value={value}>{value}%</option>)}
        </select>
        <button type="button" aria-label={translateUI("查看媒体")} title={translateUI("查看（也可双击）")} onClick={media}>↗</button>
      </div>}
      <div className="media-layout" data-alignment={alignment}>
        <div ref={frame} className={"media-frame" + (width != null || savedWidth != null ? " is-sized" : "")} style={{ width: width != null || savedWidth != null ? `${width ?? savedWidth}%` : "fit-content" }}
          onPointerDown={event => { if (event.button === 0 && (event.target as Element).tagName === "VIDEO" && editor.isEditable) select(); }} onDragStartCapture={event => event.preventDefault()}>
          {a.kind === "image" ? <img src={a.src} alt={a.title} role="button" tabIndex={0} aria-label={(editable ? translateUI("选中图片，双击查看 ") : translateUI("查看图片 ")) + a.title} onClick={editable ? select : media} onDoubleClick={event => { if (editable) { event.preventDefault(); media(); } }} onKeyDown={onKey}/>
            : <div className="inline-video"><video src={a.src} controls preload="metadata" aria-label={a.title || translateUI("视频")} onClick={event => {
              const box = event.currentTarget.getBoundingClientRect(); if (event.clientY >= box.bottom - 48) return;
              if (editor.isEditable) { event.preventDefault(); select(); } else { event.currentTarget.pause(); media(); }
            }} onDoubleClick={event => {
              const box = event.currentTarget.getBoundingClientRect(); if (!editor.isEditable || event.clientY >= box.bottom - 48) return;
              event.preventDefault(); event.stopPropagation(); event.currentTarget.pause(); media();
            }}/><button type="button" className="inline-media-expand" aria-label={translateUI("放大预览视频")} onClick={media}>⛶</button></div>}
          {active && corners.map(corner => <button type="button" key={corner} className={"media-resize-handle " + corner} aria-label={translateUI("从{0}角调整媒体大小", [({ nw: translateUI("左上"), ne: translateUI("右上"), sw: translateUI("左下"), se: translateUI("右下") }[corner])])} title={translateUI("拖动等比缩放；方向键微调；Esc 取消")} onPointerDown={event => resize(event, corner)}
            onPointerMove={event => {
              const g = gesture.current; if (!g || g.pointer !== event.pointerId) return;
              const dx = (event.clientX - g.x) * g.sx, dy = (event.clientY - g.y) * g.sy * g.ratio,
                delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy, next = clamp((g.width + delta) / Math.max(1, g.parent) * 100);
              previewWidth.current = next; setWidth(next);
            }} onPointerUp={event => {
              if (gesture.current?.pointer !== event.pointerId) return;
              const next = previewWidth.current; cancel(); if (next != null) format({ widthPercent: next }); select();
            }} onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }} onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); select(); }
              else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const value = savedWidth ?? frame.current!.getBoundingClientRect().width / Math.max(1, root.current!.clientWidth) * 100; format({ widthPercent: clamp(value + (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1)) }); }
            }}/>) }
        </div>
      </div>
    </> : a.kind === "audio" ? <div className="inline-video"><audio src={a.src} controls preload="metadata" aria-label={a.title || translateUI("音频")}/><button type="button" className="inline-media-expand" aria-label={translateUI("放大预览音频")} onClick={media}>⛶</button></div> : <div className="inline-attachment">
      <a href={a.src} target="_blank" rel="noopener noreferrer" aria-label={translateUI("打开附件 {0}", [a.title])} onClick={canPreview || a.mime === "application/pdf" ? event => { event.preventDefault(); canPreview ? preview() : media(); } : undefined}>{a.title || translateUI("附件")}</a>
      <a href={a.src + "?download=1"} download={a.title} aria-label={translateUI("下载附件 {0}", [a.title])}>{translateUI("↓ 下载")}</a>
    </div>}
  </NodeViewWrapper>;
}

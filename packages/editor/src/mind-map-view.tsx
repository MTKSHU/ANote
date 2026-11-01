import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import { newId } from "@anote/document-model/id";
import { BlockControls } from "./block-controls.js";
import { useEditorEditable } from "./editable-state.js";

type Item = { id: string; parentId: string | null; x: number; y: number; text: string };
type View = { x: number; y: number; zoom: number };
type Gesture = { pointer: number; clientX: number; clientY: number; x: number; y: number; id?: string; moved: boolean };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
function ViewIcon({ kind }: { kind: "fit" | "fullscreen" | "exit" }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d={kind === "fit" ? "M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8z" : kind === "exit" ? "M3 8h5V3 M16 3v5h5 M21 16h-5v5 M8 21v-5H3" : "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M3 16v5h5"}/>
  </svg>;
}

export function MindMapView({ node, editor, getPos, selected: blockSelected }: NodeViewProps) {
  const editable = useEditorEditable(editor), items: Item[] = [];
  node.forEach(item => items.push({ ...(item.attrs as any), x: Number(item.attrs.x) || 0, y: Number(item.attrs.y) || 0, text: item.textContent }));
  const [selected, setSelected] = useState<string | null>(null), [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState(""), [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null),
    [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 }), [fullscreen, setFullscreen] = useState(false), [notice, setNotice] = useState("");
  const shell = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null),
    gesture = useRef<Gesture | null>(null), composing = useRef(false), pendingFocus = useRef<string|null>(null), selectedRef = useRef(selected), itemsRef = useRef(items), viewRef = useRef(view);
  itemsRef.current = items; viewRef.current = view; selectedRef.current = selected;
  const active = items.find(item => item.id === selected) || items[0];
  function choose(id: string) { selectedRef.current = id; setSelected(id); }
  function moveView(next: View) { viewRef.current = next; setView(next); }
  function fit() {
    const rect = viewport.current?.getBoundingClientRect(), nodes = itemsRef.current;
    if (!rect || !nodes.length) return;
    const left = Math.min(...nodes.map(item => item.x - 80)), right = Math.max(...nodes.map(item => item.x + 80)),
      top = Math.min(...nodes.map(item => item.y - 24)), bottom = Math.max(...nodes.map(item => item.y + 24)),
      zoom = clamp(Math.min(1, (rect.width - 64) / (right - left), (rect.height - 64) / (bottom - top)), .15, 4);
    moveView({ zoom, x: rect.width / 2 - (left + right) / 2 * zoom, y: rect.height / 2 - (top + bottom) / 2 * zoom });
  }
  function zoom(factor: number, x?: number, y?: number) {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const old = viewRef.current, next = clamp(old.zoom * factor, .15, 4), ratio = next / old.zoom,
      px = x ?? rect.width / 2, py = y ?? rect.height / 2;
    moveView({ zoom: next, x: px - (px - old.x) * ratio, y: py - (py - old.y) * ratio });
  }
  function reveal(item: Item) {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const old = viewRef.current, x = item.x * old.zoom + old.x, y = item.y * old.zoom + old.y;
    if (x < 90 || x > rect.width - 90 || y < 38 || y > rect.height - 38)
      moveView({ ...old, x: rect.width / 2 - item.x * old.zoom, y: rect.height / 2 - item.y * old.zoom });
  }
  useEffect(() => {
    const element = viewport.current!;
    let previous: { width: number; height: number } | null = null;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) return;
      if (!previous) fit();
      else { const old = viewRef.current; moveView({ ...old, x: old.x + (rect.width - previous.width) / 2, y: old.y + (rect.height - previous.height) / 2 }); }
      previous = { width: rect.width, height: rect.height };
    });
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const rect = element.getBoundingClientRect(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      zoom(Math.exp(-event.deltaY * unit * .0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    const changed = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", changed);
    const root=shell.current!,escape=(event:KeyboardEvent)=>{
      if(event.key!=="Escape"||event.isComposing||document.fullscreenElement!==root||(event.target as Element).closest("input"))return;
      event.preventDefault();event.stopPropagation();void document.exitFullscreen().catch(()=>{});
    };
    document.addEventListener("keydown",escape,true);
    return () => { observer.disconnect(); element.removeEventListener("wheel", wheel); document.removeEventListener("fullscreenchange", changed); document.removeEventListener("keydown",escape,true); };
  }, []);
  useEffect(() => {
    if(editing && pendingFocus.current===editing && input.current?.closest('[data-node-id]')?.getAttribute('data-node-id')===editing){input.current.focus({preventScroll:true});input.current.select();pendingFocus.current=null;}
  }, [editing,node]);
  useEffect(() => { if (!editable) { composing.current = false; setEditing(null); gesture.current = null; setDrag(null); } }, [editable]);
  useEffect(() => { if (editing && !locate(editing)) setEditing(current=>current===editing?null:current); }, [node, editing]);

  function locate(id: string): { pos: number; item: any } | null {
    const pos = getPos(); if (typeof pos !== "number" || editor.isDestroyed) return null;
    const current = editor.state.doc.nodeAt(pos); if (current?.type.name !== "mindMap") return null;
    let found: { pos: number; item: any } | null = null;
    current.forEach((item, offset) => { if (item.attrs.id === id) found = { item, pos: pos + 1 + offset }; });
    return found;
  }
  function change(id: string, attributes?: { x: number; y: number }, text?: string) {
    if (!editor.isEditable || editor.isDestroyed) return;
    const target = locate(id); if (!target) return;
    const tr = editor.state.tr;
    if (attributes) tr.setNodeMarkup(target.pos, undefined, { ...target.item.attrs, ...attributes });
    if (text !== undefined && text !== target.item.textContent)
      tr.replaceWith(target.pos + 1, target.pos + 1 + target.item.content.size, text ? editor.schema.text(text.slice(0, 240)) : []);
    if (tr.docChanged) editor.view.dispatch(tr);
  }
  function edit(item: Item) { if (!editor.isEditable) return; composing.current = false; pendingFocus.current=item.id; choose(item.id); setDraft(item.text); setEditing(item.id); reveal(item); }
  function finish(id: string, value: string, focus = false) {
    if (composing.current) return;
    if(pendingFocus.current===id)pendingFocus.current=null;
    change(id, undefined, value); setEditing(current=>current===id?null:current);
    if (focus) viewport.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.focus({ preventScroll: true });
  }
  function add(sibling = false) {
    const nodes = itemsRef.current, current = nodes.find(item => item.id === selectedRef.current) || nodes[0], pos = getPos();
    if (!current || !editor.isEditable || nodes.length >= 300 || typeof pos !== "number") return;
    const parentId = sibling ? current.parentId : current.id; if (!parentId) return;
    const parent = nodes.find(item => item.id === parentId) || current,
      siblings = nodes.filter(item => item.parentId === parentId), x = parent.x + 240;
    let y = siblings.length ? Math.max(...siblings.map(item => item.y)) + 80 : parent.y;
    while (nodes.some(item => Math.abs(item.x - x) < 180 && Math.abs(item.y - y) < 60)) y += 80;
    const item = { id: newId(), parentId, x, y, text: translateUI("新分支") }, currentNode = editor.state.doc.nodeAt(pos);
    if (currentNode?.type.name !== "mindMap") return;
    editor.view.dispatch(editor.state.tr.insert(pos + currentNode.nodeSize - 1, editor.schema.nodes.mindMapItem.create(
      { id: item.id, parentId, x, y }, editor.schema.text(item.text),
    )));
    edit(item);
  }
  function remove() {
    const nodes = itemsRef.current, current = nodes.find(item => item.id === selectedRef.current) || nodes[0];
    if (!current?.parentId || !editor.isEditable) return;
    const ids = new Set([current.id]); let changed = true;
    while (changed) { changed = false; for (const item of nodes) if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true; } }
    const ranges = [...ids].map(locate).filter(Boolean).sort((a, b) => b!.pos - a!.pos), tr = editor.state.tr;
    for (const range of ranges) tr.delete(range!.pos, range!.pos + range!.item.nodeSize);
    editor.view.dispatch(tr); setEditing(null); choose(current.parentId);
  }
  function point(event: React.PointerEvent) {
    const rect = viewport.current!.getBoundingClientRect(), current = viewRef.current;
    return { x: (event.clientX - rect.left - current.x) / current.zoom, y: (event.clientY - rect.top - current.y) / current.zoom };
  }
  function move(event: React.PointerEvent) {
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    if (Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 3) current.moved = true;
    if (current.id) { const p = point(event); setDrag({ id: current.id, x: clamp(p.x - current.x, -100000, 100000), y: clamp(p.y - current.y, -100000, 100000) }); }
    else moveView({ ...viewRef.current, x: current.x + event.clientX - current.clientX, y: current.y + event.clientY - current.clientY });
  }
  function end(event: React.PointerEvent) {
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    if (current.id && current.moved) { const p = point(event); change(current.id, { x: clamp(p.x - current.x, -100000, 100000), y: clamp(p.y - current.y, -100000, 100000) }); }
    gesture.current = null; setDrag(null);
  }
  async function toggleFullscreen() {
    setNotice("");
    try { if (document.fullscreenElement === shell.current) await document.exitFullscreen(); else {await shell.current?.requestFullscreen();viewport.current?.focus({preventScroll:true});} }
    catch { setNotice(translateUI("无法进入全屏，请检查浏览器的全屏权限。")); }
  }
  const position = (item: Item) => drag?.id === item.id ? drag : item;
  return <NodeViewWrapper className={"mind-map" + (blockSelected ? " is-block-selected" : "")} data-block-id={node.attrs.blockId} data-testid="mind-map" contentEditable={false} onDragStartCapture={(event: React.DragEvent) => event.preventDefault()}>
    <NodeViewContent hidden aria-hidden="true" />
    <div className="mind-map-shell" ref={shell}>
      <div className="mind-map-tools">
        <strong>{translateUI("思维导图")}</strong><span />
        {editable && <><button type="button" onClick={() => add()}>{translateUI("添加子节点")}</button><button type="button" disabled={!active?.parentId} onClick={() => add(true)}>{translateUI("添加同级")}</button><button type="button" disabled={!active?.parentId} onClick={remove}>{translateUI("删除分支")}</button></>}
        <div className="mind-map-view-tools" role="group" aria-label={translateUI("思维导图视图")}>
          <button type="button" aria-label={translateUI("缩小思维导图")} title={translateUI("缩小")} onClick={() => zoom(1 / 1.2)}>−</button><output aria-label={translateUI("思维导图缩放比例")}>{Math.round(view.zoom * 100)}%</output><button type="button" aria-label={translateUI("放大思维导图")} title={translateUI("放大")} onClick={() => zoom(1.2)}>＋</button>
          <button type="button" aria-label={translateUI("适应思维导图画布")} title={translateUI("适应画布")} onClick={fit}><ViewIcon kind="fit" /></button>
        </div>
        <BlockControls editor={editor} getPos={getPos} selected={blockSelected} label={translateUI("思维导图")} />
        <button className="mind-map-fullscreen" type="button" aria-label={fullscreen ? translateUI("退出思维导图全屏") : translateUI("全屏查看思维导图")} title={fullscreen ? translateUI("退出全屏") : translateUI("全屏查看")} onClick={() => void toggleFullscreen()}><ViewIcon kind={fullscreen ? "exit" : "fullscreen"} /></button>
        <small>{editable ? translateUI("双击或空格编辑 · Tab 添加子节点 · Enter 添加同级 · 拖动节点调整位置 · 滚轮缩放，空白处拖动") : translateUI("滚轮缩放 · 空白处拖动")}</small>
        {notice && <small role="status">{notice}</small>}
      </div>
      <div ref={viewport} className="mind-map-viewport" tabIndex={0} aria-label={translateUI("思维导图画布")} data-zoom={view.zoom} data-pan-x={view.x} data-pan-y={view.y}
        onMouseDown={event => { if (!(event.target as Element).closest("input")) event.preventDefault(); }}
        onPointerDown={event => {
          if (event.button !== 0 || (event.target as Element).closest(".mind-map-node")) return;
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
          gesture.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: viewRef.current.x, y: viewRef.current.y, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { gesture.current = null; setDrag(null); }}
        onKeyDown={event => { if ((event.target as Element).closest("input,.mind-map-node")) return; if (["+", "=", "-", "0"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); event.key === "0" ? fit() : zoom(event.key === "-" ? 1 / 1.2 : 1.2); } }}>
        <svg role="group" aria-label={translateUI("可视化思维导图")} width="100%" height="100%">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            <g className="mind-map-edges" aria-hidden="true">{items.map(item => {
              const parent = items.find(p => p.id === item.parentId); if (!parent) return null;
              const p = position(parent), c = position(item), direction = c.x >= p.x ? 1 : -1,
                start = p.x + 80 * direction, end = c.x - 80 * direction, bend = Math.max(42, Math.abs(end - start) * .55);
              return <path key={item.id} fill="none" stroke="var(--accent, #365fc4)" strokeWidth="2" vectorEffect="non-scaling-stroke" d={`M ${start} ${p.y} C ${start + bend * direction} ${p.y}, ${end - bend * direction} ${c.y}, ${end} ${c.y}`} />;
            })}</g>
            {items.map(item => {
              const p = position(item);
              return <foreignObject key={item.id} x={p.x - 80} y={p.y - 24} width="160" height="48">
                <div className={"mind-map-node" + (active?.id === item.id ? " active" : "") + (editing === item.id ? " is-editing" : "")} data-node-id={item.id} role="group" aria-label={translateUI("节点 {0}", [(item.text || translateUI("空白"))])} tabIndex={0}
                  onPointerDown={event => {
                    if (event.button !== 0 || (event.target as Element).closest("input")) return;
                    event.preventDefault(); event.stopPropagation(); choose(item.id); event.currentTarget.focus({ preventScroll: true });
                    if (!editor.isEditable) return;
                    const q = point(event); gesture.current = { id: item.id, pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: q.x - p.x, y: q.y - p.y, moved: false };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }} onDoubleClick={event => { if ((event.target as Element).closest("input")) return; event.preventDefault(); event.stopPropagation(); edit(item); }}
                  onKeyDown={event => {
                    if ((event.target as Element).closest("input") || event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (!editable && (event.key === " " || event.key === "Spacebar")) {event.preventDefault();event.stopPropagation();return;}
                    if ([" ", "Spacebar", "Enter", "Tab", "Delete", "Backspace"].includes(event.key) && !(event.key === "Tab" && event.shiftKey) && editable) {
                      event.preventDefault(); event.stopPropagation(); choose(item.id);
                      if (event.key === " " || event.key === "Spacebar") edit(item);
                      else if (event.key === "Tab") add(); else if (event.key === "Enter") add(!!item.parentId); else remove();
                    }
                  }}>
                  {editing === item.id && editable ? <input ref={input} aria-label={translateUI("节点文字 {0}", [item.id])} value={draft} maxLength={240}
                    onChange={event => { setDraft(event.target.value); if (!composing.current) change(item.id, undefined, event.target.value); }}
                    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; change(item.id, undefined, event.currentTarget.value); }}
                    onBlur={event => finish(item.id, event.target.value)}
                    onKeyDown={event => {
                      event.stopPropagation(); if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
                      if (event.key === "Escape") { event.preventDefault(); finish(item.id, event.currentTarget.value, true); }
                      else if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); finish(item.id, event.currentTarget.value); add(); }
                      else if (event.key === "Enter") { event.preventDefault(); finish(item.id, event.currentTarget.value); add(!!item.parentId); }
                    }} /> : <span className="mind-map-node-label" title={item.text}>{item.text || translateUI("空白节点")}</span>}
                </div>
              </foreignObject>;
            })}
          </g>
        </svg>
      </div>
    </div>
  </NodeViewWrapper>;
}

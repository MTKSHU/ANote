import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { newId } from "@anote/document-model/id";

type View = { x: number; y: number; zoom: number };
type Diagram = { svg: string; width: number; height: number; code: string };
type Gesture = { pointer: number; clientX: number; clientY: number; x: number; y: number; moved: boolean };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function dimensions(svg: string) {
  const element = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const box = element.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = box?.[2] || Number.parseFloat(element.getAttribute("width") || ""),
    height = box?.[3] || Number.parseFloat(element.getAttribute("height") || "");
  return {
    width: Number.isFinite(width) && width > 0 ? width : 800,
    height: Number.isFinite(height) && height > 0 ? height : 400,
  };
}

export function MermaidPreview({ code, onSelect }: { code: string; onSelect?: () => void }) {
  const [diagram, setDiagram] = useState<Diagram | null>(null), [error, setError] = useState(""),
    [dark, setDark] = useState(document.documentElement.dataset.theme === "dark"),
    [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 }), [panning, setPanning] = useState(false);
  const viewport = useRef<HTMLDivElement>(null), viewRef = useRef(view), diagramRef = useRef(diagram),
    fittedCode = useRef<string | null>(null), gesture = useRef<Gesture | null>(null);
  diagramRef.current = diagram;
  function moveView(next: View) { viewRef.current = next; setView(next); }
  function fit() {
    const rect = viewport.current?.getBoundingClientRect(), size = diagramRef.current;
    if (!rect || !size || !rect.width || !rect.height) return;
    const zoom = clamp(Math.min(1, (rect.width - 32) / size.width, (rect.height - 32) / size.height), .05, 4);
    moveView({ zoom, x: (rect.width - size.width * zoom) / 2, y: (rect.height - size.height * zoom) / 2 });
  }
  function zoomBy(factor: number, x?: number, y?: number) {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const old = viewRef.current, zoom = clamp(old.zoom * factor, .05, 4), ratio = zoom / old.zoom,
      px = x ?? rect.width / 2, py = y ?? rect.height / 2;
    moveView({ zoom, x: px - (px - old.x) * ratio, y: py - (py - old.y) * ratio });
  }
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.theme === "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (code.length > 50_000) throw new Error(translateUI("图表源码超过 50,000 字符，请拆分图表。"));
          const { default: mermaid } = await import("mermaid");
          mermaid.initialize({
            startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default",
            flowchart: { htmlLabels: false }, maxTextSize: 50_000, maxEdges: 500, suppressErrorRendering: true,
            secure: ["securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "secure"],
          });
          const result = await mermaid.render("diagram-" + newId(), code);
          if (active) { setDiagram({ svg: result.svg, ...dimensions(result.svg), code }); setError(""); }
        } catch (e) {
          if (active) { setDiagram(null); setError((e as Error).message); }
        }
      })();
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [code, dark]);
  useEffect(() => {
    if (diagram && fittedCode.current !== diagram.code) { fit(); fittedCode.current = diagram.code; }
  }, [diagram]);
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
      if (!diagramRef.current) return;
      event.preventDefault(); event.stopPropagation();
      const rect = element.getBoundingClientRect(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      zoomBy(Math.exp(clamp(-event.deltaY * unit * .0015, -4, 4)), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener("wheel", wheel); };
  }, []);
  function end(event: React.PointerEvent) {
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    gesture.current = null; setPanning(false);
    if (!current.moved) onSelect?.();
  }
  return <div className="mermaid-preview" contentEditable={false} onDragStartCapture={event => event.preventDefault()}>
    <div className="mermaid-view-tools" role="group" aria-label={translateUI("Mermaid 视图")}>
      <button type="button" aria-label={translateUI("缩小 Mermaid 图表")} title={translateUI("缩小")} disabled={!diagram} onClick={() => zoomBy(1 / 1.2)}>−</button>
      <output aria-label={translateUI("Mermaid 缩放比例")}>{Math.round(view.zoom * 100)}%</output>
      <button type="button" aria-label={translateUI("放大 Mermaid 图表")} title={translateUI("放大")} disabled={!diagram} onClick={() => zoomBy(1.2)}>＋</button>
      <button type="button" aria-label={translateUI("适应 Mermaid 画布")} title={translateUI("适应画布")} disabled={!diagram} onClick={fit}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8z"/></svg>
      </button>
      <small>{translateUI("滚轮缩放 · 按住画布拖动")}</small>
    </div>
    <div className={"mermaid-viewport" + (panning ? " is-panning" : "")} ref={viewport} tabIndex={0} role="group" aria-label={translateUI("Mermaid 图表画布")}
      data-zoom={view.zoom} data-pan-x={view.x} data-pan-y={view.y}
      onMouseDown={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0 || !diagram) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        gesture.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: viewRef.current.x, y: viewRef.current.y, moved: false };
        setPanning(true); event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
        if (Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 3) current.moved = true;
        if (current.moved) moveView({ ...viewRef.current, x: current.x + event.clientX - current.clientX, y: current.y + event.clientY - current.clientY });
      }} onPointerUp={end} onPointerCancel={() => { gesture.current = null; setPanning(false); }} onLostPointerCapture={() => { gesture.current = null; setPanning(false); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || !diagram) return;
        if (["+", "=", "-", "0"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); event.key === "0" ? fit() : zoomBy(event.key === "-" ? 1 / 1.2 : 1.2); }
        else if (onSelect && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); onSelect(); }
      }}>
      {error ? <p role="alert">{translateUI("图表语法有误：")}{error}</p> : diagram ?
        <div className="mermaid-stage" style={{ width: diagram.width, height: diagram.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <iframe title={translateUI("Mermaid 图表")} tabIndex={-1} sandbox="" srcDoc={
            '<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:; font-src data:"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;color-scheme:' +
            (dark ? "dark;background:#1b2230;color:#e5e9f0" : "light;background:#fff;color:#242833") + ';font-family:sans-serif}body>svg{width:100%!important;height:100%!important;max-width:none!important;display:block}</style></head><body>' + diagram.svg + '</body></html>'
          }/>
        </div> : <p role="status">{translateUI("正在生成图表…")}</p>}
    </div>
  </div>;
}

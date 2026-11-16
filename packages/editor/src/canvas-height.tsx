import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";

export const DEFAULT_CANVAS_HEIGHT=420,MIN_CANVAS_HEIGHT=240,MAX_CANVAS_HEIGHT=1600;
const bounded=(value:number)=>Math.max(MIN_CANVAS_HEIGHT,Math.min(MAX_CANVAS_HEIGHT,Math.round(value)));

/** Drag locally; commit once on release so resizing does not rebuild the editor. */
export function useCanvasHeight(value:number|undefined,onCommit?:(height:number)=>void) {
  const initial=()=>bounded(Number(value)||DEFAULT_CANVAS_HEIGHT),[height,setHeight]=useState(initial),current=useRef(height),
    gesture=useRef<{pointer:number;y:number;height:number}|null>(null);
  current.current=height;
  useEffect(()=>{if(!gesture.current){const next=initial();current.current=next;setHeight(next);}},[value]);
  const resize=(next:number)=>{current.current=bounded(next);setHeight(current.current);};
  return {height,handle:{
    onPointerDown:(event:React.PointerEvent)=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);gesture.current={pointer:event.pointerId,y:event.clientY,height:current.current};},
    onPointerMove:(event:React.PointerEvent)=>{const start=gesture.current;if(!start||event.pointerId!==start.pointer)return;event.preventDefault();event.stopPropagation();resize(start.height+event.clientY-start.y);},
    onPointerUp:(event:React.PointerEvent)=>{const start=gesture.current;if(!start||event.pointerId!==start.pointer)return;event.preventDefault();event.stopPropagation();resize(start.height+event.clientY-start.y);gesture.current=null;onCommit?.(current.current);},
    onPointerCancel:()=>{if(gesture.current){gesture.current=null;resize(initial());}},
    onLostPointerCapture:()=>{if(gesture.current){gesture.current=null;resize(initial());}},
    onKeyDown:(event:React.KeyboardEvent)=>{if(!["ArrowUp","ArrowDown","Home","End"].includes(event.key))return;event.preventDefault();event.stopPropagation();resize(event.key==="Home"?MIN_CANVAS_HEIGHT:event.key==="End"?MAX_CANVAS_HEIGHT:current.current+(event.key==="ArrowUp"?-40:40));onCommit?.(current.current);},
  }};
}

export function CanvasHeightHandle({label,height,handle}:{label:string;height:number;handle:ReturnType<typeof useCanvasHeight>["handle"]}) {
  return <div className="diagram-height-handle" role="separator" aria-label={label} aria-orientation="horizontal" aria-valuemin={MIN_CANVAS_HEIGHT} aria-valuemax={MAX_CANVAS_HEIGHT} aria-valuenow={height} tabIndex={0} title={translateUI("上下拖动调整画布高度；方向键微调")} contentEditable={false} {...handle}><span aria-hidden="true"/></div>;
}

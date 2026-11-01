import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";
import {NodeViewWrapper,type NodeViewProps} from "@tiptap/react";
import {useEditorEditable} from "./editable-state.js";
import {BlockControls} from "./block-controls.js";

export function ComparisonView({node,editor,updateAttributes,getPos,selected}:NodeViewProps){
  const a=node.attrs,images=a.images||[],editable=useEditorEditable(editor);
  const [slider,setSlider]=useState(Number(a.slider)||50),[zoom,setZoom]=useState(Number(a.zoom)||1),[pair,setPair]=useState([0,1]);
  const dragging=useRef(false),canvas=useRef<HTMLDivElement>(null),position=useRef(slider);
  useEffect(()=>{if(!dragging.current){setSlider(Number(a.slider));position.current=Number(a.slider);}},[a.slider]);
  useEffect(()=>setZoom(Number(a.zoom)||1),[a.zoom]);
  const update=(attrs:any)=>{if(editor.isEditable)updateAttributes(attrs);};
  function slide(event:React.PointerEvent){const r=canvas.current!.getBoundingClientRect(),value=Math.max(0,Math.min(100,(event.clientX-r.left)/r.width*100));position.current=value;setSlider(value);}
  function finish(event:React.PointerEvent){if(!dragging.current)return;slide(event);dragging.current=false;update({slider:position.current,layout:"slider"});}
  const before=images[pair[0]],after=images[pair[1]],transform=`translate(${a.panX||0}px,${a.panY||0}px) scale(${zoom})`;
  return <NodeViewWrapper className="comparison" data-testid="image-comparison" data-block-id={a.blockId} contentEditable={false} onDragStartCapture={(event:React.DragEvent)=>{event.preventDefault();event.stopPropagation();}}>
    <div className="comparison-title"><span>{translateUI("双图对比")}</span><small>{translateUI("拖动图片区域调整对比位置")}</small><BlockControls editor={editor} getPos={getPos} selected={selected} label={translateUI("双图对比")}/></div>
    {images.length>2&&<div className="comparison-legacy-pair">{[0,1].map((side)=><label key={side}>{side?translateUI("右图"):translateUI("左图")}<select aria-label={side?translateUI("右侧对比图片"):translateUI("左侧对比图片")} value={pair[side]} onChange={event=>{const next=[...pair];next[side]=Number(event.target.value);if(next[0]!==next[1])setPair(next);}}>{images.map((image:any,i:number)=><option key={i} value={i} disabled={i===pair[1-side]}>{image.label||translateUI("图片 {0}", [i+1])}</option>)}</select></label>)}<small>{translateUI("旧版图片均保留，选择其中两张比较。")}</small></div>}
    <div ref={canvas} className="comparison-canvas" role="slider" tabIndex={0} aria-label={translateUI("对比位置")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(slider)}
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();dragging.current=true;event.currentTarget.setPointerCapture(event.pointerId);slide(event);}}
      onPointerMove={event=>{if(dragging.current)slide(event);}} onPointerUp={finish} onPointerCancel={()=>{dragging.current=false;setSlider(Number(a.slider));}}
      onKeyDown={event=>{const delta=event.key==="ArrowLeft"?-2:event.key==="ArrowRight"?2:0;if(delta){event.preventDefault();const value=Math.max(0,Math.min(100,slider+delta));setSlider(value);position.current=value;update({slider:value,layout:"slider"});}}}>
      <div className="comparison-before" style={{clipPath:`inset(0 ${100-slider}% 0 0)`}}><img src={before?.src} alt={before?.label||translateUI("左侧图片")} style={{transform}} draggable={false}/></div>
      <div className="comparison-after" style={{clipPath:`inset(0 0 0 ${slider}%)`}}><img src={after?.src} alt={after?.label||translateUI("右侧图片")} style={{transform}} draggable={false}/></div>
      <span className="comparison-line" style={{left:`${slider}%`}}>↔</span><span className="image-label left">{before?.label}</span><span className="image-label right">{after?.label}</span>
    </div>
    <div className="comparison-controls"><button onClick={()=>{const value=Math.max(.5,zoom-.25);setZoom(value);update({zoom:value});}} aria-label={translateUI("缩小对比图片")}>−</button><span>{Math.round(zoom*100)}%</span><button onClick={()=>{const value=Math.min(3,zoom+.25);setZoom(value);update({zoom:value});}} aria-label={translateUI("放大对比图片")}>＋</button><button onClick={()=>{setZoom(1);setSlider(50);position.current=50;update({zoom:1,slider:50,panX:0,panY:0,layout:"slider"});}}>{translateUI("复位")}</button></div>
    {editable&&<details className="comparison-settings"><summary>{translateUI("对比说明")}</summary><label>{translateUI("说明")}<input aria-label={translateUI("对比说明")} value={a.caption} onChange={event=>update({caption:event.target.value})}/></label>{pair.map((index,side)=><label key={side}>{side?translateUI("右图"):translateUI("左图")}{translateUI("说明")}<input aria-label={translateUI("图片说明 {0}", [(side+1)])} value={images[index]?.label||""} onChange={event=>update({images:images.map((image:any,i:number)=>i===index?{...image,label:event.target.value}:image)})}/></label>)}</details>}
    {a.caption&&<figcaption>{a.caption}</figcaption>}
  </NodeViewWrapper>;
}

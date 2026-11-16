import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";
import {NodeViewWrapper,type NodeViewProps} from "@tiptap/react";
import {BlockControls} from "./block-controls.js";
import {useMediaActivation} from "./media-activation.js";

export function ComparisonView({node,editor,updateAttributes,getPos,selected}:NodeViewProps){
  const a=node.attrs,images=a.images||[];
  const [slider,setSlider]=useState(Number(a.slider)||50),[zoom,setZoom]=useState(Number(a.zoom)||1),[pair,setPair]=useState([0,1]);
  const [orientation,setOrientation]=useState(a.orientation||"horizontal"),gesture=useRef<{x:number;y:number;initial:number;moved:boolean}|null>(null);
  const click=useRef<{x:number;y:number;time:number;orientation:string;pair:string;initial:number;image:any}|null>(null);
  const vertical=orientation==="vertical";
  const dragging=useRef(false),canvas=useRef<HTMLDivElement>(null),position=useRef(slider);
  useEffect(()=>{if(!dragging.current){setSlider(Number(a.slider));position.current=Number(a.slider);}},[a.slider]);
  useEffect(()=>setZoom(Number(a.zoom)||1),[a.zoom]);
  useEffect(()=>setOrientation(a.orientation||"horizontal"),[a.orientation]);
  const update=(attrs:any)=>{if(editor.isEditable)updateAttributes(attrs);};
  function coordinate(event:{clientX:number;clientY:number}){const r=canvas.current!.getBoundingClientRect();return (vertical?(event.clientY-r.top)/r.height:(event.clientX-r.left)/r.width)*100;}
  function slide(event:React.PointerEvent){const value=Math.max(0,Math.min(100,coordinate(event)));position.current=value;setSlider(value);}
  function finish(event:React.PointerEvent){if(!dragging.current)return;slide(event);update({slider:position.current,layout:"slider"});if(gesture.current?.moved)click.current=null;dragging.current=false;gesture.current=null;}
  const before=images[pair[0]],after=images[pair[1]],transform=`translate(${a.panX||0}px,${a.panY||0}px) scale(${zoom})`;
  const root=useRef<HTMLDivElement>(null),{activated,activate}=useMediaActivation(root,JSON.stringify([before?.src,after?.src]));
  return <NodeViewWrapper ref={root} className="comparison" data-testid="image-comparison" data-media-loaded={activated?"true":"false"} data-block-id={a.blockId} contentEditable={false} onDragStartCapture={(event:React.DragEvent)=>{event.preventDefault();event.stopPropagation();}}>
    <div className="comparison-title"><span>{translateUI("双图对比")}</span><div className="comparison-orientation" role="group" aria-label={translateUI("对比方向")}>{[["horizontal",translateUI("左右对比")],["vertical",translateUI("上下对比")]].map(([value,label])=><button key={value} aria-pressed={orientation===value} onClick={()=>{setOrientation(value);update({orientation:value});}}>{label}</button>)}</div>
      <div className="comparison-controls" role="group" aria-label={translateUI("双图视图")}><button onClick={()=>{const value=Math.max(.5,zoom-.25);setZoom(value);update({zoom:value});}} aria-label={translateUI("缩小对比图片")}>−</button><output aria-label={translateUI("双图缩放比例")}>{Math.round(zoom*100)}%</output><button onClick={()=>{const value=Math.min(3,zoom+.25);setZoom(value);update({zoom:value});}} aria-label={translateUI("放大对比图片")}>＋</button><button onClick={()=>{setZoom(1);setSlider(50);position.current=50;update({zoom:1,slider:50,panX:0,panY:0,layout:"slider"});}}>{translateUI("复位")}</button></div>
      <BlockControls editor={editor} getPos={getPos} selected={selected} label={translateUI("双图对比")}/></div>
    {images.length>2&&<div className="comparison-legacy-pair">{[0,1].map((side)=><label key={side}>{side?translateUI("右图"):translateUI("左图")}<select aria-label={side?translateUI("右侧对比图片"):translateUI("左侧对比图片")} value={pair[side]} onChange={event=>{const next=[...pair];next[side]=Number(event.target.value);if(next[0]!==next[1])setPair(next);}}>{images.map((image:any,i:number)=><option key={i} value={i} disabled={i===pair[1-side]}>{image.label||translateUI("图片 {0}", [i+1])}</option>)}</select></label>)}<small>{translateUI("旧版图片均保留，选择其中两张比较。")}</small></div>}
    <div ref={canvas} className={"comparison-canvas"+(vertical?" is-vertical":"")} role="slider" tabIndex={0} aria-label={translateUI("对比位置")} aria-orientation={vertical?"vertical":"horizontal"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(slider)}
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.focus({preventScroll:true});const previous=click.current,now=performance.now();if(!previous||now-previous.time>500||Math.hypot(event.clientX-previous.x,event.clientY-previous.y)>5||previous.orientation!==orientation||previous.pair!==pair.join(","))click.current={x:event.clientX,y:event.clientY,time:now,orientation,pair:pair.join(","),initial:slider,image:coordinate(event)<=slider?before:after};dragging.current=true;gesture.current={x:event.clientX,y:event.clientY,initial:slider,moved:false};event.currentTarget.setPointerCapture(event.pointerId);slide(event);}}
      onPointerMove={event=>{if(dragging.current&&gesture.current){if(Math.hypot(event.clientX-gesture.current.x,event.clientY-gesture.current.y)>3)gesture.current.moved=true;if(gesture.current.moved)slide(event);}}} onPointerUp={finish} onPointerCancel={()=>{dragging.current=false;const value=gesture.current?.initial??Number(a.slider);setSlider(value);position.current=value;gesture.current=null;}}
      onDoubleClick={event=>{event.preventDefault();event.stopPropagation();const initial=click.current,image=initial?.image||(coordinate(event)<=slider?before:after);if(initial){setSlider(initial.initial);position.current=initial.initial;update({slider:initial.initial});}click.current=null;if(image?.src)window.dispatchEvent(new CustomEvent("anote-preview-media",{detail:{src:image.src,kind:"image",title:image.label||translateUI("对比图片")}}));}}
      onKeyDown={event=>{if(event.key==="Enter"&&!activated){event.preventDefault();activate();return;}const delta=event.key===(vertical?"ArrowUp":"ArrowLeft")?-2:event.key===(vertical?"ArrowDown":"ArrowRight")?2:0;if(delta){event.preventDefault();const value=Math.max(0,Math.min(100,slider+delta));setSlider(value);position.current=value;update({slider:value,layout:"slider"});}}}>
      {!activated&&<div className="media-load-placeholder"><span>{translateUI("双图对比")}</span><button type="button" onPointerDown={event=>event.stopPropagation()} onClick={activate}>{translateUI("加载对比图片")}</button></div>}
      <div className="comparison-before" style={{clipPath:vertical?`inset(0 0 ${100-slider}% 0)`:`inset(0 ${100-slider}% 0 0)`}}>{activated&&<img src={before?.src} loading="lazy" decoding="async" alt={before?.label||(vertical?translateUI("上方图片"):translateUI("左侧图片"))} style={{transform}} draggable={false}/>}</div>
      <div className="comparison-after" style={{clipPath:vertical?`inset(${slider}% 0 0 0)`:`inset(0 0 0 ${slider}%)`}}>{activated&&<img src={after?.src} loading="lazy" decoding="async" alt={after?.label||(vertical?translateUI("下方图片"):translateUI("右侧图片"))} style={{transform}} draggable={false}/>}</div>
      <span className="comparison-line" style={vertical?{top:`${slider}%`}:{left:`${slider}%`}}>{vertical?"↕":"↔"}</span><span className="image-label left">{before?.label}</span><span className="image-label right">{after?.label}</span>
    </div>
    {a.caption&&<figcaption>{a.caption}</figcaption>}
  </NodeViewWrapper>;
}

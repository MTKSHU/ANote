import { t as translateUI } from "@anote/i18n";
import React,{lazy,Suspense,useEffect,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {useDialog,DialogClose} from "./dialog";
import {Icon} from "./icons";
const PanoramaViewer=lazy(()=>import("@anote/editor/panorama"));
export type PreviewMedia={src:string;kind:string;title?:string;mime?:string;projection?:string};
export function MediaViewer({media,onClose,children,label=translateUI("媒体预览")}:{media:PreviewMedia;onClose:()=>void;children?:ReactNode;label?:string}){
  const dialog=useDialog(onClose),stage=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null);
  const [view,setView]=useState({zoom:1,x:0,y:0}),[error,setError]=useState("");
  const [projection,setProjection]=useState(media.projection||"flat");
  const panoramic=projection==="equirectangular"&&["image","video"].includes(media.kind);
  useEffect(()=>setProjection(media.projection||"flat"),[media.src,media.kind,media.projection]);
  const drag=useRef<{x:number;y:number;panX:number;panY:number}|null>(null);
  function zoom(factor:number){setView(v=>({...v,zoom:Math.max(.1,Math.min(8,v.zoom*factor))}));}
  useEffect(()=>{
    setView({zoom:1,x:0,y:0});setError("");
    const node=stage.current;if(!node||media.kind!=="image"||panoramic)return;
    const wheel=(event:WheelEvent)=>{event.preventDefault();const r=node.getBoundingClientRect(),x=event.clientX-r.left-r.width/2,y=event.clientY-r.top-r.height/2;setView(v=>{const z=Math.max(.1,Math.min(8,v.zoom*Math.exp(-event.deltaY*.002))),ratio=z/v.zoom;return {zoom:z,x:x-(x-v.x)*ratio,y:y-(y-v.y)*ratio};});};
    node.addEventListener("wheel",wheel,{passive:false});return ()=>node.removeEventListener("wheel",wheel);
  },[media.src,media.kind,panoramic]);
  return createPortal(<div className="modal media-lightbox-overlay"><section ref={dialog} className="media-lightbox" role="dialog" aria-label={label}>
    <div className="media-lightbox-tools">
      {media.kind==="image"&&!panoramic&&<><button aria-label={translateUI("缩小图片")} title={translateUI("缩小")} onClick={()=>zoom(1/1.25)}>−</button><span aria-live="polite">{Math.round(view.zoom*100)}%</span><button aria-label={translateUI("放大图片")} title={translateUI("放大")} onClick={()=>zoom(1.25)}>＋</button><button aria-label={translateUI("图片复位")} title={translateUI("适应窗口")} onClick={()=>setView({zoom:1,x:0,y:0})}><Icon name="fit"/></button></>}
      {["image","video"].includes(media.kind)&&<button aria-label={panoramic?translateUI("查看平面媒体"):translateUI("以360°全景查看")} title={panoramic?translateUI("查看平面原件"):translateUI("按等距柱状360°全景查看")} onClick={()=>setProjection(panoramic?"flat":"equirectangular")}>{panoramic?translateUI("平面"):"360°"}</button>}
      {media.kind==="video"&&!panoramic&&<button aria-label={translateUI("视频全屏")} title={translateUI("视频全屏")} onClick={()=>{void video.current?.requestFullscreen?.().catch(()=>setError(translateUI("请使用播放器的全屏按钮")));}}><Icon name="fullscreen"/></button>}
      <DialogClose onClick={onClose} label={translateUI("关闭预览")}/>
    </div>
    <div ref={stage} className={"media-lightbox-stage "+(panoramic?"is-panorama":media.kind==="image"?"is-image":"")} data-zoom={view.zoom} data-pan-x={view.x} data-pan-y={view.y}
      onPointerDown={event=>{if(media.kind!=="image"||panoramic||event.button!==0)return;event.preventDefault();drag.current={x:event.clientX,y:event.clientY,panX:view.x,panY:view.y};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{const p=drag.current;if(p)setView(v=>({...v,x:p.panX+event.clientX-p.x,y:p.panY+event.clientY-p.y}));}}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
      onKeyDown={event=>{if(media.kind!=="image"||panoramic)return;if(["+","=","-","0"].includes(event.key)){event.preventDefault();if(event.key==="0")setView({zoom:1,x:0,y:0});else zoom(event.key==="-"?1/1.25:1.25);}}}>
      {panoramic?<Suspense fallback={<p role="status">{translateUI("正在准备全景查看器…")}</p>}><PanoramaViewer src={media.src} kind={media.kind as "image"|"video"} title={media.title}/></Suspense>:media.kind==="image"?<img src={media.src} alt={media.title||translateUI("图片")} draggable={false} style={{transform:`translate(${view.x}px,${view.y}px) scale(${view.zoom})`}} onDragStart={event=>event.preventDefault()} onDoubleClick={()=>setView(v=>v.zoom===1?{zoom:2,x:0,y:0}:{zoom:1,x:0,y:0})}/>
        :media.kind==="video"?<video ref={video} src={media.src} controls autoPlay playsInline preload="metadata" aria-label={translateUI("视频播放器")}/>
        :media.kind==="audio"?<audio src={media.src} controls autoPlay preload="none" aria-label={translateUI("音频播放器")} onError={()=>setError(translateUI("音频暂时无法播放，请确认附件已下载或网络连接正常，也可下载后用本机播放器打开。"))}/>
        :media.mime==="application/pdf"?<iframe title={translateUI("PDF 文档")} src={media.src}/>
        :children||<div className="media-file-fallback"><p>{translateUI("此格式请使用本机应用打开。")}</p><a href={media.src} target="_blank" rel="noopener noreferrer">{translateUI("打开原文件")}</a></div>}
    </div>
    {error&&<p className="media-lightbox-error" role="status">{error}{media.kind==="audio"&&<> <a href={media.src+(media.src.includes("?")?"&":"?")+"download=1"} download={media.title}>{translateUI("下载音频")}</a></>}</p>}
  </section></div>,document.body);
}
export function MediaViewerHost(){
  const [media,setMedia]=useState<PreviewMedia|null>(null);
  useEffect(()=>{const open=(event:Event)=>{const value=(event as CustomEvent<PreviewMedia>).detail;if(value&&typeof value.src==="string"&&(["image","video","audio"].includes(value.kind)||value.mime==="application/pdf"))setMedia(value);};window.addEventListener("anote-preview-media",open);return ()=>window.removeEventListener("anote-preview-media",open);},[]);
  return media?<MediaViewer key={media.src} media={media} onClose={()=>setMedia(null)}/>:null;
}

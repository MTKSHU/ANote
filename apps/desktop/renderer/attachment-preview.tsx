import { t as translateUI } from "@anote/i18n";
import React,{lazy,Suspense,useEffect,useState} from "react";
import {request} from "./native";
import {MediaViewer} from "./media-viewer";
const ScenePreview=lazy(()=>import("../../web/src/scene-preview"));
export function AttachmentPreview({id,onClose,onError}:{id:string;onClose:()=>void;onError:(s:string)=>void}){
  const [asset,setAsset]=useState<any>(null),[error,setError]=useState("");
  useEffect(()=>{let live=true;void request("assets/"+id).then(value=>{if(live)setAsset(value);}).catch(error=>{if(live)setError(translateUI(error.message));});return ()=>{live=false;};},[id]);
  return <MediaViewer media={asset?{src:asset.url,kind:asset.kind,title:asset.title,mime:asset.mime}:{src:"",kind:"loading"}} label={translateUI("附件预览")} onClose={onClose}>
    {error?<p role="alert">{error}</p>:!asset?<p role="status">{translateUI("正在载入…")}</p>:["mesh","pointcloud","gaussian"].includes(asset.kind)?<Suspense fallback={<p>{translateUI("正在准备渲染器…")}</p>}><ScenePreview asset={asset}/></Suspense>:<div className="media-file-fallback"><p>{translateUI("此格式请使用本机应用打开。")}</p><a href={asset.url} target="_blank" rel="noopener noreferrer">{translateUI("打开原文件")}</a></div>}
  </MediaViewer>;
}

import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useState} from "react";
import {request} from "./native";

type Library={id:string;name:string;kind:string;team_id?:string;created_by?:string;role:string};
type Folder={id:string;name:string;parent_id:string|null};
export function NoteLocationPicker({source,libraries,libraryId,folderId,disabled,onChange}:{source:Library;libraries:Library[];libraryId:string;folderId:string;disabled:boolean;onChange:(library:string,folder:string)=>void}){
  const [folders,setFolders]=useState<Folder[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState("");
  useEffect(()=>{let active=true;setFolders([]);setLoading(true);setError("");request(`spaces/${libraryId}/folders`).then(value=>{if(active)setFolders(value);}).catch(e=>{if(active)setError(translateUI(e.message));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[libraryId]);
  const choices=libraries.filter(l=>l.id===source.id||["admin","editor","contributor"].includes(l.role)&&l.kind===source.kind&&(source.kind==="team"?l.team_id===source.team_id:l.created_by===source.created_by));
  function path(item:Folder){const names=[item.name],seen=new Set([item.id]);let parent=folders.find(f=>f.id===item.parent_id);while(parent&&!seen.has(parent.id)){seen.add(parent.id);names.unshift(parent.name);const parentId=parent.parent_id;parent=folders.find(f=>f.id===parentId);}return names.join(" / ");}
  return <div className="note-location-field">
    <label>{translateUI("移动到其他知识库")}<select aria-label={translateUI("移动到其他知识库")} value={libraryId} disabled={disabled} onChange={e=>onChange(e.target.value,"")}>{choices.map(l=><option key={l.id} value={l.id}>{l.name}{l.id===source.id?translateUI("（当前）"):""}</option>)}</select></label>
    <label className="note-location-folder">{translateUI("目录")}<select aria-label={translateUI("目标目录")} value={folderId} disabled={disabled||loading} onChange={e=>onChange(libraryId,e.target.value)}><option value="">{loading?translateUI("正在读取目录…"):translateUI("知识库根目录")}</option>{folders.map(f=><option key={f.id} value={f.id}>{path(f)}</option>)}</select></label>
    {error&&<p role="alert">{error}</p>}
  </div>;
}

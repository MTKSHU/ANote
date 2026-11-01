import { t as translateUI } from "@anote/i18n";
import React, { useState } from "react";
import { Icon } from "./icons";
type Entry = {key:string;kind:"folder"|"note";id:string;parent_id:string|null};
type Catalog = {revision:string;items:Entry[]};
const mime = "application/x-anote-item";
export function LibraryOutline({catalog,folders,notes,storageKey,canOrganize,canCreate,showAuthors=false,noteRow,onFolder,onMove}: {
  catalog:Catalog;folders:any[];notes:any[];storageKey:string;canOrganize:boolean;canCreate:boolean;
  showAuthors?:boolean;
  noteRow:(note:any)=>React.ReactNode;onFolder:(folder:any)=>void;
  onMove:(entry:Entry,parent:string|null,before:string|null)=>Promise<void>;
}) {
  const [closed,setClosed] = useState<Set<string>>(() => {try {return new Set(JSON.parse(localStorage.getItem(storageKey) || "[]"));} catch {return new Set();}});
  const [hint,setHint] = useState<{key:string;zone:string}|null>(null);
  const [moving,setMoving] = useState(false);
  function toggle(id:string) {const next = new Set(closed); next.has(id) ? next.delete(id) : next.add(id);setClosed(next);try {localStorage.setItem(storageKey,JSON.stringify([...next]));}catch{}}
  function zone(e:React.DragEvent,entry:Entry) {const rect=e.currentTarget.getBoundingClientRect(),y=(e.clientY-rect.top)/rect.height;return entry.kind === "folder" && y>.25 && y<.75 ? "inside" : y<.5 ? "before" : "after";}
  async function drop(e:React.DragEvent,target:Entry|null) {
    e.preventDefault();e.stopPropagation();setHint(null);
    let source:Entry;try {const key=e.dataTransfer.getData(mime);source=catalog.items.find(item=>item.key===key)!;}catch{return;}
    if (!source || moving || source.key===target?.key) return;
    const side=target?zone(e,target):"inside",parent=target?(side==="inside"?target.id:target.parent_id):null;
    const siblings=catalog.items.filter(item=>item.parent_id===parent && item.key!==source.key && (item.kind==="folder"?folders.some(f=>f.id===item.id):notes.some(n=>n.id===item.id)));
    const before=target && side!=="inside" ? side==="before"?target.key:siblings[siblings.findIndex(item=>item.key===target.key)+1]?.key || null : null;
    setMoving(true);try {await onMove(source,parent,before);if(parent && side==="inside" && closed.has(parent)) toggle(parent);} finally {setMoving(false);}
  }
  function branch(parent:string|null,depth=0):React.ReactNode {
    if(depth>100) return null;
    return catalog.items.filter(entry=>entry.parent_id===parent).map(entry=>{
      const data=entry.kind==="folder"?folders.find(f=>f.id===entry.id):notes.find(n=>n.id===entry.id);
      if(!data)return null;
      const movable=entry.kind==="folder"?canOrganize:canCreate && data.role==="admin";
      const expanded=!closed.has(entry.id);
      return <React.Fragment key={entry.key}>
        <div className={"outline-item "+entry.kind+(hint?.key===entry.key?" drop-"+hint.zone:"")} data-item-key={entry.key} style={{"--outline-depth":depth} as React.CSSProperties}
          draggable={movable&&!moving} onDragStart={e=>{if(!movable){e.preventDefault();return;}e.dataTransfer.setData(mime,entry.key);e.dataTransfer.effectAllowed="move";}} onDragEnd={()=>setHint(null)}
          onDragOver={e=>{if(e.dataTransfer.types.includes(mime)){e.preventDefault();e.stopPropagation();setHint({key:entry.key,zone:zone(e,entry)});}}}
          onDrop={e=>void drop(e,entry)}>
          {entry.kind==="folder"?<div className="library-folder outline-folder">
            <button className="folder-open" draggable={movable&&!moving} aria-expanded={expanded} onClick={()=>toggle(entry.id)}><Icon name={expanded?"down":"chevron"} size={14}/><Icon name="folder" size={20}/><span>{data.name}</span></button>
            {canOrganize&&<button className="row-more" aria-label={translateUI("管理目录 {0}", [data.name])} onClick={()=>onFolder(data)}><Icon name="more" size={17}/></button>}
          </div>:noteRow(data)}
        </div>
        {entry.kind==="folder"&&expanded&&branch(entry.id,depth+1)}
      </React.Fragment>;
    });
  }
  return <div className={"library-outline note-table"+(showAuthors?" has-authors":"")} aria-label={translateUI("知识库内容")} aria-busy={moving}>
    <div className="note-table-head"><span>{translateUI("目录与笔记")}</span>{showAuthors&&<span className="note-author-heading">{translateUI("作者")}</span>}<span className="note-visibility-heading">{translateUI("可见范围")}</span><span className="note-updated-heading">{translateUI("最近更新")}</span><span/></div>
    {branch(null)}
    {!catalog.items.length&&<p className="muted">{translateUI("暂无目录或笔记")}</p>}
    {(canOrganize||canCreate)&&<div className={"outline-root-drop"+(hint?.key==="root"?" drop-inside":"")} onDragOver={e=>{if(e.dataTransfer.types.includes(mime)){e.preventDefault();setHint({key:"root",zone:"inside"});}}} onDrop={e=>void drop(e,null)}>{translateUI("拖到这里移至知识库根目录末尾")}</div>}
  </div>;
}

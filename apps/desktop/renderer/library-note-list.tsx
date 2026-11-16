import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useId,useRef,useState} from "react";
import { Icon } from "./icons";
import { useSidebarVisibility } from "./sidebar-visibility";
import {useNoteListPreferences} from "./note-list-preferences";

type Note = {id:string;title:string;role?:string;folder_id?:string|null;folder_name?:string};
type Folder={id:string;name:string;parent_id:string|null};
type Entry = {id:string;kind:"folder"|"note";parent_id:string|null};
type Branch={entry:Entry;children:Branch[]};

/** Preserve mixed folder/note catalog order, including entries arriving during refresh. */
function noteTree(notes:Note[],folders:Folder[],entries:Entry[]):Branch[] {
  const valid=(e:Entry)=>e.kind==="folder"?folders.some(f=>f.id===e.id):notes.some(n=>n.id===e.id);
  const ordered=entries.filter(valid),known=new Set(ordered.map(e=>e.kind+":"+e.id));
  for(const folder of folders)if(!known.has("folder:"+folder.id))ordered.push({...folder,kind:"folder"});
  for(const note of [...notes].sort((a,b)=>a.id.localeCompare(b.id)))if(!known.has("note:"+note.id))ordered.push({id:note.id,kind:"note",parent_id:note.folder_id||null});
  const visited=new Set<string>();
  function branch(entry:Entry,depth=0):Branch|null {
    const key=entry.kind+":"+entry.id;if(visited.has(key)||depth>100)return null;visited.add(key);
    return {entry,children:entry.kind==="folder"?ordered.filter(e=>e.parent_id===entry.id).map(e=>branch(e,depth+1)).filter((b):b is Branch=>!!b):[]};
  }
  const result=ordered.filter(e=>!e.parent_id).map(e=>branch(e)).filter((b):b is Branch=>!!b);
  for(const entry of ordered){const item=branch(entry);if(item)result.push(item);}
  return result;
}

const dragType="application/x-anote-library-list";
export function LibraryNoteList({serverURL,userId,library,notes,folders,entries,selected,onSelect,onLibrary,canCreate,canOrganize,onCreate,onSettings,onNewFolder,onFolderSettings,onMove,compact=false}: {
  serverURL:string;userId:string;library:{id:string;name:string};notes:Note[];folders:Folder[];entries:Entry[];
  selected:string;onSelect:(note:Note)=>void;onLibrary:()=>void;
  canCreate:boolean;canOrganize:boolean;onCreate:()=>void;onSettings:(note:Note)=>void;onNewFolder:(parent:string|null)=>void;onFolderSettings:(folder:Folder)=>void;onMove:(entry:Entry,parent:string|null,before:string|null)=>Promise<void>;
  compact?:boolean;
}) {
  const [storedCollapsed,setCollapsed] = useSidebarVisibility(serverURL,userId,"note-list");
  const collapsed=!compact&&storedCollapsed;
  const {width,setWidth,closed,toggleFolder}=useNoteListPreferences(serverURL,userId,library.id);
  const root=useRef<HTMLElement>(null),drag=useRef<{pointer:number;x:number;width:number;last:number}|null>(null),id=useId();
  const [maxWidth,setMaxWidth]=useState(480),[resizing,setResizing]=useState(false);
  const [dragging,setDragging]=useState(false),[moving,setMoving]=useState(false),[hint,setHint]=useState<{key:string;zone:string}|null>(null);
  const keyOf=(entry:Entry)=>entry.kind+":"+entry.id;
  const movable=(entry:Entry)=>entry.kind==="folder"?canOrganize:canCreate&&notes.find(note=>note.id===entry.id)?.role==="admin";
  function zone(event:React.DragEvent,entry:Entry){const rect=event.currentTarget.getBoundingClientRect(),at=(event.clientY-rect.top)/rect.height;return entry.kind==="folder"&&at>.25&&at<.75?"inside":at<.5?"before":"after";}
  async function drop(event:React.DragEvent,target:Entry|null){
    event.preventDefault();event.stopPropagation();setHint(null);setDragging(false);
    let payload:{library:string;key:string};try{payload=JSON.parse(event.dataTransfer.getData(dragType));}catch{return;}
    const source=entries.find(entry=>keyOf(entry)===payload.key);
    if(payload.library!==library.id||!source||!movable(source)||moving||target&&keyOf(source)===keyOf(target))return;
    const side=target?zone(event,target):"inside",parent=target?side==="inside"?target.id:target.parent_id:null;
    const siblings=entries.filter(entry=>entry.parent_id===parent&&keyOf(entry)!==keyOf(source)&&(entry.kind==="folder"?folders.some(folder=>folder.id===entry.id):notes.some(note=>note.id===entry.id)));
    const before=target&&side!=="inside"?side==="before"?keyOf(target):siblings[siblings.findIndex(entry=>keyOf(entry)===keyOf(target))+1]?keyOf(siblings[siblings.findIndex(entry=>keyOf(entry)===keyOf(target))+1]):null:null;
    setMoving(true);try{await onMove(source,parent,before);if(parent&&side==="inside"&&closed.has(parent))toggleFolder(parent);}finally{setMoving(false);}
  }
  function dragProps(entry:Entry){return {
    draggable:movable(entry)&&!moving,
    onDragStart:(event:React.DragEvent)=>{if(!movable(entry)){event.preventDefault();return;}event.dataTransfer.setData(dragType,JSON.stringify({library:library.id,key:keyOf(entry)}));event.dataTransfer.effectAllowed="move";setDragging(true);},
    onDragEnd:()=>{setDragging(false);setHint(null);},
    onDragOver:(event:React.DragEvent)=>{if(event.dataTransfer.types.includes(dragType)){event.preventDefault();event.stopPropagation();setHint({key:keyOf(entry),zone:zone(event,entry)});}},
    onDrop:(event:React.DragEvent)=>void drop(event,entry),
  };}
  useEffect(()=>{
    if(compact)return;
    const parent=root.current?.parentElement;if(!parent)return;
    const update=()=>{const size=parent.getBoundingClientRect().width;setMaxWidth(Math.max(176,Math.min(480,Math.floor(size<=760?size*.85:size-320))));};
    update();const observer=new ResizeObserver(update);observer.observe(parent);return()=>observer.disconnect();
  },[compact]);
  const actualWidth=Math.min(width,maxWidth),clamp=(value:number)=>Math.max(176,Math.min(maxWidth,Math.round(value)));
  function finish(){if(drag.current){setWidth(drag.current.last);drag.current=null;}setResizing(false);}
  function render(branches:Branch[],depth=0):React.ReactNode {
    return branches.map(({entry,children})=>{
      const style={"--note-depth":depth} as React.CSSProperties;
      if(entry.kind==="note") {
        const note=notes.find(n=>n.id===entry.id)!;
        return <div key={"note:"+note.id} data-list-entry={keyOf(entry)} className={"note-list-row"+(hint?.key===keyOf(entry)?" drop-"+hint.zone:"")} {...dragProps(entry)}>
          <button className="note-list-item" style={style} aria-current={note.id===selected?"page":undefined} title={[note.title,note.folder_name].filter(Boolean).join(" · ")} onClick={()=>onSelect(note)}><Icon name="file" size={15}/><span>{note.title||translateUI("未命名笔记")}</span></button>
          {note.role==="admin"&&<button className="note-list-settings" aria-label={translateUI("笔记设置 {0}", [note.title])} title={translateUI("笔记设置")} onClick={()=>onSettings(note)}><Icon name="more" size={16}/></button>}
        </div>;
      }
      const folder=folders.find(f=>f.id===entry.id)!,expanded=!closed.has(folder.id),group=id+"-"+folder.id;
      return <React.Fragment key={"folder:"+folder.id}>
        <div className="note-list-row note-list-folder-row">
          <button data-list-entry={keyOf(entry)} className={"note-list-folder"+(hint?.key===keyOf(entry)?" drop-"+hint.zone:"")} style={style} title={folder.name} aria-expanded={expanded} aria-controls={group} onClick={()=>toggleFolder(folder.id)} {...dragProps(entry)}><Icon name={expanded?"down":"chevron"} size={12} className="folder-chevron"/><Icon name="folder" size={15}/><span>{folder.name}</span></button>
          {canOrganize&&<button className="note-list-settings" aria-label={translateUI("管理目录 {0}", [folder.name])} title={translateUI("管理目录")} onClick={()=>onFolderSettings(folder)}><Icon name="more" size={16}/></button>}
        </div>
        <div id={group} hidden={!expanded}>{render(children,depth+1)}</div>
      </React.Fragment>;
    });
  }
  return <aside ref={root} className={"library-note-list"+(collapsed?" is-collapsed":"")+(resizing?" is-resizing":"")} style={{"--note-list-width":actualWidth+"px"} as React.CSSProperties} aria-label={translateUI("同库笔记")}>
    <header>
      <button className="note-list-library" hidden={collapsed} onClick={onLibrary} title={library.name}><span>{library.name}</span></button>
      {canCreate&&!collapsed&&<button className="note-list-add" aria-label={translateUI("新建笔记")} title={translateUI("新建笔记")} onClick={onCreate}><Icon name="plus" size={17}/></button>}
      {canOrganize&&!collapsed&&<button className="note-list-add" aria-label={translateUI("新建目录")} title={translateUI("新建目录")} onClick={()=>onNewFolder(null)}><Icon name="folder-plus" size={17}/></button>}
      {!compact&&<button className="note-list-toggle" aria-label={collapsed?translateUI("显示笔记列表"):translateUI("隐藏笔记列表")} title={collapsed?translateUI("显示笔记列表"):translateUI("隐藏笔记列表")} aria-expanded={!collapsed} aria-controls={id} onClick={()=>setCollapsed(!collapsed)}>
        <Icon name={collapsed?"list-expand":"list-collapse"} size={18}/>
      </button>}
    </header>
    <nav id={id} aria-label={translateUI("知识库笔记列表")} aria-busy={moving} hidden={collapsed}>{render(noteTree(notes,folders,entries))}
      {dragging&&<div className={"note-list-root-drop"+(hint?.key==="root"?" drop-inside":"")} onDragOver={event=>{if(event.dataTransfer.types.includes(dragType)){event.preventDefault();setHint({key:"root",zone:"inside"});}}} onDrop={event=>void drop(event,null)}>{translateUI("移至根目录")}</div>}
    </nav>
    {!collapsed&&!compact&&<div className="note-list-resizer" role="separator" aria-label={translateUI("调整笔记列表宽度")} aria-orientation="vertical" aria-valuemin={176} aria-valuemax={maxWidth} aria-valuenow={actualWidth} tabIndex={0} title={translateUI("拖动调整宽度，双击恢复默认")}
      onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();drag.current={pointer:e.pointerId,x:e.clientX,width:actualWidth,last:actualWidth};e.currentTarget.setPointerCapture(e.pointerId);setResizing(true);}}
      onPointerMove={e=>{const start=drag.current;if(!start||start.pointer!==e.pointerId)return;start.last=clamp(start.width+e.clientX-start.x);setWidth(start.last,false);}}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={()=>setWidth(208)}
      onKeyDown={e=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;e.preventDefault();setWidth(clamp(e.key==="Home"?176:e.key==="End"?maxWidth:actualWidth+(e.key==="ArrowRight"?16:-16)));}}/>}
  </aside>;
}

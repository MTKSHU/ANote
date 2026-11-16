import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useMemo,useRef,useState} from "react";
import type {Editor} from "@tiptap/core";
import {noteHref,referencedNoteIds} from "@anote/document-model/note-links";
import {useDialog,DialogClose} from "./dialog";
import {Icon} from "./icons";
import "./note-links.css";

/** The workspace supplies only metadata that the current account may read. */
export type NoteLinkTarget={id:string;title:string;space_name?:string};

export function NoteLinkPicker({editor,notes,currentId,onClose}:{editor:Editor;notes:NoteLinkTarget[];currentId?:string;onClose:()=>void}){
  const modal=useDialog<HTMLElement>(onClose),bookmark=useRef(editor.state.selection.getBookmark());
  const [query,setQuery]=useState(""),[active,setActive]=useState(0),[error,setError]=useState("");
  const candidates=useMemo(()=>{
    const text=query.trim().toLocaleLowerCase(),seen=new Set<string>();
    return notes.filter(note=>{
      if(note.id===currentId||seen.has(note.id))return false;
      seen.add(note.id);
      return !text||[note.title,note.space_name].filter(Boolean).join(" ").toLocaleLowerCase().includes(text);
    });
  },[notes,currentId,query]);
  const visible=candidates.slice(0,50),selected=Math.min(active,Math.max(0,visible.length-1));
  useEffect(()=>{
    const map=({transaction}:{transaction:any})=>{bookmark.current=bookmark.current.map(transaction.mapping);};
    editor.on("transaction",map);return()=>{editor.off("transaction",map);};
  },[editor]);
  useEffect(()=>{setActive(0);},[query]);
  useEffect(()=>{modal.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({block:"nearest"});},[selected]);
  function choose(id:string){
    const note=notes.find(item=>item.id===id&&item.id!==currentId);
    if(!note){setError(translateUI("这篇笔记已不可用，请重新选择。"));return;}
    if(editor.isDestroyed||!editor.isEditable){setError(translateUI("当前笔记不能编辑。"));return;}
    try{
      const selection=bookmark.current.resolve(editor.state.doc),href=noteHref(note.id);
      const chain=editor.chain().focus().setTextSelection({from:selection.from,to:selection.to});
      const saved=selection.empty
        ?chain.insertContent({type:"text",text:note.title||translateUI("未命名笔记"),marks:[{type:"link",attrs:{href,target:null,rel:null}}]}).unsetMark("link").run()
        :chain.setLink({href,target:null,rel:null}).setTextSelection(selection.to).unsetMark("link").run();
      if(!saved){setError(translateUI("无法在当前位置插入笔记链接。"));return;}
      onClose();
    }catch{setError(translateUI("插入位置已变化，请关闭后重新选择正文位置。"));}
  }
  return <div className="modal note-link-modal" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section ref={modal} role="dialog" aria-label={translateUI("插入笔记链接")} className="note-link-picker">
      <header><h2>{translateUI("笔记链接")}</h2><DialogClose onClick={onClose}/></header>
      <label className="note-link-search"><Icon name="search"/><input autoFocus aria-label={translateUI("搜索可读笔记")} value={query} placeholder={translateUI("搜索笔记名称或知识库")} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="note-link-results" aria-activedescendant={visible.length?"note-link-option-"+selected:undefined} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(["ArrowDown","ArrowUp"].includes(event.key)&&visible.length){event.preventDefault();setActive((selected+(event.key==="ArrowDown"?1:-1)+visible.length)%visible.length);}
        else if(event.key==="Enter"&&visible[selected]){event.preventDefault();choose(visible[selected].id);}
      }}/></label>
      <div id="note-link-results" role="listbox" aria-label={translateUI("可链接的笔记")} className="note-link-results">
        {visible.map((note,index)=><button key={note.id} id={"note-link-option-"+index} type="button" role="option" aria-selected={index===selected} data-active={index===selected} onMouseDown={event=>event.preventDefault()} onPointerMove={()=>setActive(index)} onClick={()=>choose(note.id)}>
          <Icon name="file"/><span><strong>{note.title||translateUI("未命名笔记")}</strong>{note.space_name&&<small>{note.space_name}</small>}</span><Icon name="chevron" size={14}/>
        </button>)}
        {!visible.length&&<p>{query.trim()?translateUI("没有找到匹配的可读笔记。"):translateUI("暂无其他可链接的笔记。")}</p>}
      </div>
      {error&&<p role="alert" className="note-link-error">{error}</p>}
      <footer>{candidates.length>50?translateUI("结果较多，请输入更具体的名称。"):translateUI("可选择当前账号有阅读权限的笔记。")}<button type="button" onClick={onClose}>{translateUI("取消")}</button></footer>
    </section>
  </div>;
}

export function NoteReferences({editor,notes,currentId,onOpen}:{editor:Editor|null;notes:NoteLinkTarget[];currentId:string;onOpen?:(id:string)=>void}){
  const [ids,setIds]=useState<string[]>([]);
  useEffect(()=>{
    if(!editor||editor.isDestroyed){setIds([]);return;}
    let timer:ReturnType<typeof setTimeout>|undefined;
    const update=()=>{const next=referencedNoteIds(editor.state.doc,window.location.origin);setIds(previous=>previous.length===next.length&&previous.every((id,index)=>id===next[index])?previous:next);};
    const schedule=()=>{clearTimeout(timer);timer=setTimeout(update,120);};
    editor.on("update",schedule);update();return()=>{clearTimeout(timer);editor.off("update",schedule);};
  },[editor,currentId]);
  const readable=new Map(notes.map(note=>[note.id,note])),references=ids.filter(id=>id!==currentId&&readable.has(id)).map(id=>readable.get(id)!);
  if(!references.length)return null;
  return <section className="note-references" aria-label={translateUI("参考笔记")}>
    <header><Icon name="book" size={17}/><h2>{translateUI("参考笔记")}</h2><span>{references.length}</span></header>
    <ul>{references.map(note=><li key={note.id}><a href={noteHref(note.id)} data-note-reference={note.id} onClick={event=>{if(onOpen&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();onOpen(note.id);}}}>
      <Icon name="file" size={16}/><span><strong>{note.title||translateUI("未命名笔记")}</strong>{note.space_name&&<small>{note.space_name}</small>}</span><Icon name="chevron" size={14}/>
    </a></li>)}</ul>
  </section>;
}

import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import type {Editor} from "@tiptap/core";
import {newId} from "@anote/document-model/id";
export type MentionCandidate={id:string;name:string;username:string;email?:string|null};
export type MentionLoader=(query:string)=>Promise<MentionCandidate[]>;

export function MentionPicker({editor,load,actorId}:{editor:Editor;load:MentionLoader;actorId:string}) {
  const [range,setRange]=useState<{from:number;to:number;query:string;left:number;top:number}|null>(null),[items,setItems]=useState<MentionCandidate[]>([]),[index,setIndex]=useState(0),[loading,setLoading]=useState(false),[failed,setFailed]=useState(false);
  const config=useRef({load,actorId});config.current={load,actorId};
  const current=useRef({range,items,index});current.current={range,items,index};
  const dismissed=useRef("");
  useEffect(()=>{
    const dom=editor.view.dom;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const update=()=>{
      if(editor.isDestroyed||!editor.isEditable||editor.view.composing||editor.view.dom.dataset.composing==="true"){setRange(null);return;}
      const {selection}=editor.state;
      if(!selection.empty||selection.$from.parent.type.name==="codeBlock"||editor.isActive("code")||editor.isActive("mention")||editor.isActive("link")){setRange(null);return;}
      const before=selection.$from.parent.textBetween(0,selection.$from.parentOffset,"\n","\ufffc"),match=/(?:^|[\s(（，。,:：])@([^\s]{0,254})$/u.exec(before);
      if(!match){dismissed.current="";setRange(null);return;}
      const from=selection.from-match[1].length-1,to=selection.from,key=from+":"+match[1];
      if(dismissed.current===key){setRange(null);return;}
      const rect=editor.view.coordsAtPos(to),menuWidth=Math.min(340,window.innerWidth-16);
      setRange(previous=>previous?.from===from&&previous.to===to&&previous.query===match[1]?previous:{from,to,query:match[1],left:Math.max(8,Math.min(rect.left,window.innerWidth-menuWidth-8)),top:rect.bottom+260<window.innerHeight?rect.bottom+6:Math.max(8,rect.top-260)});
    };
    const afterComposition=()=>{clearTimeout(timer);timer=setTimeout(update,0);};
    editor.on("transaction",update);editor.on("selectionUpdate",update);dom.addEventListener("compositionend",afterComposition);
    return()=>{clearTimeout(timer);editor.off("transaction",update);editor.off("selectionUpdate",update);dom.removeEventListener("compositionend",afterComposition);};
  },[editor]);
  useEffect(()=>{
    if(!range){setItems([]);return;}let active=true;setLoading(true);setFailed(false);setItems([]);setIndex(0);
    const timer=setTimeout(()=>{void config.current.load(range.query).then(values=>{if(active)setItems(values);}).catch(()=>{if(active)setFailed(true);}).finally(()=>{if(active)setLoading(false);});},150);
    return()=>{active=false;clearTimeout(timer);};
  },[range?.from,range?.query]);
  function choose(item:MentionCandidate){
    const value=current.current.range;if(!value||!editor.isEditable||editor.view.composing)return;
    setRange(null);dismissed.current=value.from+":"+value.query;
    editor.chain().focus().insertContentAt({from:value.from,to:value.to},[{type:"text",text:"@"+item.name,marks:[{type:"mention",attrs:{userId:item.id,actorId:config.current.actorId,mentionId:newId()}}]},{type:"text",text:" "}]).run();
  }
  useEffect(()=>{
    const dom=editor.view.dom;
    const keydown=(event:KeyboardEvent)=>{
      const value=current.current;if(!value.range||event.isComposing||editor.view.composing)return;
      if(event.key==="Escape"){event.preventDefault();event.stopPropagation();dismissed.current=value.range.from+":"+value.range.query;setRange(null);}
      else if(value.items.length&&["ArrowDown","ArrowUp","Enter"].includes(event.key)){
        event.preventDefault();event.stopPropagation();if(event.key==="Enter")choose(value.items[value.index]);else setIndex((value.index+(event.key==="ArrowDown"?1:-1)+value.items.length)%value.items.length);
      }
    };
    const close=(event:PointerEvent)=>{if(!(event.target as Element).closest(".mention-picker")&&!dom.contains(event.target as Node))setRange(null);};
    dom.addEventListener("keydown",keydown,true);document.addEventListener("pointerdown",close);
    return()=>{dom.removeEventListener("keydown",keydown,true);document.removeEventListener("pointerdown",close);};
  },[editor]);
  if(!range)return null;
  return createPortal(<div className="mention-picker" role="listbox" aria-label={translateUI("提及成员或好友")} style={{left:range.left,top:range.top}} onMouseDown={e=>e.preventDefault()}>
    {loading?<p role="status">{translateUI("正在查找…")}</p>:items.length?items.map((item,i)=>{
      const secondary=item.email||(!item.username.startsWith("sso-")?"@"+item.username:"");
      return <button key={item.id} role="option" aria-selected={i===index} title={[item.name,secondary].filter(Boolean).join(" · ")} onMouseEnter={()=>setIndex(i)} onClick={()=>choose(item)}><strong>{item.name}</strong>{secondary&&<small>{secondary}</small>}</button>;
    }):<p>{failed?translateUI("暂时无法查找，请稍后重试"):translateUI("没有可提及的成员或好友")}</p>}
    {items.length>0&&<p>{translateUI("提及不会更改笔记访问权限")}</p>}
  </div>,document.body);
}

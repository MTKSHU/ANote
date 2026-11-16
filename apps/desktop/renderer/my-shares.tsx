import { t as translateUI } from "@anote/i18n";
import React, {useEffect, useState} from "react";
import {request} from "./native";
import {Icon} from "./icons";
import {Sharing} from "./sharing";
import {DialogClose,useDialog} from "./dialog";
import "./my-shares.css";
import {LibrarySharing} from "./library-sharing";
import {ShareLinkRecord} from "./share-link-settings";

type Share = {id:string;title:string;space_name:string;team_name:string|null;member_count:number;archived:boolean;external_allowed:boolean;active:boolean;links:{id:string;created_at:string;expires_at:string|null;revoked_at:string|null}[]};
export function MyShares({scope,query,offline,serverURL,onOpenNote,onOpenLibrary,onChanged,kind,onKindChange:setKind,status,onStatusChange:setStatus}:{scope:string;query:string;offline:boolean;serverURL:string;onOpenNote:(id:string)=>void;onOpenLibrary:(id:string)=>void;onChanged:()=>void;kind:string;onKindChange:(kind:string)=>void;status:string;onStatusChange:(status:string)=>void}) {
  const [items,setItems]=useState<Share[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0),[error,setError]=useState(""),[notice,setNotice]=useState(""),[sharing,setSharing]=useState<string|null>(null),[target,setTarget]=useState<Share|null>(null),[busy,setBusy]=useState(false);
  const confirm = useDialog(()=>setTarget(null),{open:!!target,disabled:busy});
  useEffect(()=>{setPage(1);setSharing(null);setTarget(null);setNotice("");},[query,status,kind]);
  useEffect(()=>{
    let live=true;setLoading(true);setError("");
    const timer=setTimeout(()=>{void request((kind==="libraries"?"me/library-shares?":"me/shares?")+new URLSearchParams({q:query,status,page:String(page),scope})).then(result=>{if(live){setItems(result.items);setTotal(result.total);if(!result.items.length&&page>1)setPage(page-1);}}).catch(e=>{if(live){setItems([]);setError(translateUI(e.message));}}).finally(()=>{if(live)setLoading(false);});},query?200:0);
    return()=>{live=false;clearTimeout(timer);};
  },[query,status,page,revision,kind,scope]);
  function changed(){setRevision(value=>value+1);onChanged();}
  function liveLinks(item:Share){return item.links.filter(link=>!link.revoked_at&&(!link.expires_at||Date.parse(link.expires_at)>Date.now()));}
  return <section className="my-shares" aria-label={translateUI("我的分享")}>
    <nav className="management-tabs" aria-label={translateUI("分享内容")}>{[["notes",translateUI("笔记")],["libraries",translateUI("知识库")]].filter(([value])=>scope==="personal"||value==="notes").map(([value,label])=><button key={value} className={kind===value?"active":""} onClick={()=>setKind(value)}>{label}</button>)}</nav>
    <div className="shares-toolbar"><p>{translateUI("集中管理你创建的外链和笔记成员授权。")}</p><label>{translateUI("分享状态")}<select aria-label={translateUI("分享状态")} value={status} onChange={e=>setStatus(e.target.value)}><option value="active">{translateUI("分享中")}</option><option value="all">{translateUI("全部记录")}</option><option value="inactive">{translateUI("已失效／已撤销")}</option></select></label></div>
    {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="share-notice" role="status">{notice}</p>}
    {loading?<div className="academic-empty" role="status">{translateUI("正在加载分享…")}</div>:<>
      <div className="shares-table"><div className="shares-table-head"><span>{kind==="libraries"?translateUI("知识库"):translateUI("笔记")}</span><span>{translateUI("分享状态")}</span><span>{translateUI("操作")}</span></div>
        {items.map(item=><article className="shares-row" key={item.id} data-share-note={item.id}>
          <button className="share-note-open" onClick={()=>kind==="libraries"?onOpenLibrary(item.id):onOpenNote(item.id)}><Icon name={kind==="libraries"?"book":"file"}/><span><strong>{item.title}</strong><small>{[item.team_name,item.space_name].filter(Boolean).join(" / ")}</small></span></button>
          <div className="shares-summary">{item.member_count>0&&<span>{item.member_count}{translateUI(" 位指定成员")}</span>}{liveLinks(item).length>0&&<span>{liveLinks(item).length}{translateUI(" 条")}{item.external_allowed&&!item.archived?translateUI("有效外链"):translateUI("暂停访问的外链")}</span>}{item.links.some(link=>link.expires_at===null&&!link.revoked_at)&&<small>{translateUI("包含永久外链")}</small>}{!item.active&&<span>{translateUI("已失效／已撤销")}</span>}</div>
          <div className="shares-actions"><button disabled={offline} onClick={()=>setSharing(item.id)}><Icon name="settings" size={15}/>{translateUI("管理分享")}</button>{item.links.some(link=>!link.revoked_at)&&<button className="share-revoke" disabled={offline} onClick={()=>setTarget(item)}>{translateUI("撤销外链")}</button>}</div>
          {item.links.length>0&&<details className="shares-link-history"><summary>{translateUI("外链记录（")}{item.links.length}）</summary>{item.links.map(link=><ShareLinkRecord key={link.id} link={link} serverURL={serverURL}/>)}</details>}
        </article>)}
      </div>
      {!items.length&&!error&&<div className="academic-empty"><Icon name="share" size={32}/><h3>{query?translateUI("没有匹配的分享"):translateUI("暂无此类分享")}</h3><p>{translateUI("在笔记中生成外链或授权成员后，可以在这里管理。")}</p></div>}
      {total>30&&<div className="shares-pagination"><button disabled={page===1} onClick={()=>setPage(value=>value-1)}>{translateUI("上一页")}</button><span>{page} / {Math.ceil(total/30)}</span><button disabled={page*30>=total} onClick={()=>setPage(value=>value+1)}>{translateUI("下一页")}</button></div>}
    </>}
    {sharing&&(kind==="libraries"?<LibrarySharing id={sharing} serverURL={serverURL} onClose={()=>setSharing(null)} onChanged={changed}/>:<Sharing id={sharing} space="" serverURL={serverURL} onClose={()=>setSharing(null)} onChanged={changed}/>)}
    {target&&<div className="modal academic-modal"><section ref={confirm} className="academic-dialog" role="dialog" aria-label={translateUI("撤销外链")}><header><h2>{translateUI("撤销外链")}</h2><DialogClose disabled={busy} onClick={()=>setTarget(null)}/></header><p>{translateUI("撤销你为“")}{target.title}{translateUI("”创建的全部外链？已发出的链接将无法继续访问。")}</p><footer><button disabled={busy} onClick={()=>setTarget(null)}>{translateUI("取消")}</button><button className="danger" disabled={busy} onClick={async()=>{setBusy(true);try{const result=await request(`me/${kind==="libraries"?"library-shares":"shares"}/${target.id}/links`,"DELETE");setTarget(null);setNotice(translateUI("已撤销 {0} 条外链", [result.revoked]));changed();}catch(e){setError(translateUI((e as Error).message));}finally{setBusy(false);}}}>{busy?translateUI("正在撤销…"):translateUI("确认撤销")}</button></footer></section></div>}
  </section>;
}

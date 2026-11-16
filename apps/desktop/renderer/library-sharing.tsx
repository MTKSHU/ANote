import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";
import {request} from "./native";
import {DialogClose,useDialog} from "./dialog";
import {Icon} from "./icons";
import {ReadOnlyNote} from "./sharing";
import "./library-sharing.css";
import {WatermarkFields,ShareLinkRecord,ShareWatermark} from "./share-link-settings";

export function LibrarySharing({id,serverURL,onClose,onChanged}:{id:string;serverURL:string;onClose:()=>void;onChanged:()=>void}) {
  const [value,setValue]=useState<any>(null),[tab,setTab]=useState("members"),[identity,setIdentity]=useState(""),[days,setDays]=useState<number|null>(7),[url,setURL]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const dialog=useDialog(onClose,{disabled:busy}),current=useRef(id);current.current=id;
  const [watermarkEnabled,setWatermarkEnabled]=useState(true),[watermarkText,setWatermarkText]=useState("");
  async function refresh(){const next=await request(`spaces/${id}/sharing`);if(current.current===id)setValue(next);}
  useEffect(()=>{setValue(null);void refresh().catch(e=>setError(translateUI(e.message)));},[id]);
  async function mutate(endpoint:string,method:string,body?:any){if(busy)return;setBusy(true);setError("");setNotice("");try{const result=await request(endpoint,method,body);await refresh();onChanged();return result;}catch(e){setError(translateUI((e as Error).message));}finally{setBusy(false);}}
  return <div className="modal academic-modal"><section ref={dialog} className="academic-dialog library-sharing-dialog" role="dialog" aria-label={translateUI("分享知识库")}>
    <header><h2>{translateUI("分享知识库")}</h2><DialogClose disabled={busy} onClick={onClose}/></header>
    <div className="dialog-body">
      <p className="library-sharing-scope">“{value?.library.name || translateUI("此知识库")}{translateUI("”以整库只读方式分享，覆盖现有及后续新增的笔记。互联网访问不展示归档和已删除的内容。")}</p>
      <nav className="management-tabs" aria-label={translateUI("知识库分享方式")}>{[["members",translateUI("指定成员")],["internet",translateUI("互联网")]].map(([key,label])=><button key={key} className={tab===key?"active":""} onClick={()=>setTab(key)}>{label}</button>)}</nav>
      {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="share-notice" role="status">{notice}</p>}
      {!value?<p role="status">{translateUI("正在加载分享设置…")}</p>:tab==="members"?<>
        <form className="library-share-member-add" onSubmit={async e=>{e.preventDefault();const result=await mutate(`spaces/${id}/sharing/members`,"POST",{identity});if(result){setIdentity("");setNotice(translateUI("已添加只读成员"));}}}>
          <label>{translateUI("完整用户名或已验证邮箱")}<input aria-label={translateUI("完整用户名或已验证邮箱")} autoComplete="off" maxLength={254} required value={identity} onChange={e=>setIdentity(e.target.value)}/></label>
          <button className="primary" disabled={busy||!identity.trim()}>{translateUI("添加只读成员")}</button>
        </form>
        <div className="library-share-members">{value.members.map((member:any)=><div className="library-share-member" key={member.id}><span>{member.name}</span><small>{translateUI("只读")}</small><button disabled={busy} aria-label={translateUI("撤销成员 {0}", [member.name])} onClick={async()=>{const result=await mutate(`spaces/${id}/sharing/members/${member.id}`,"DELETE");if(result)setNotice(translateUI("已撤销整库访问权限"));}}>{translateUI("撤销访问")}</button></div>)}{!value.members.length&&<p className="muted">{translateUI("尚未分享给指定成员。")}</p>}</div>
      </>:<>
        <WatermarkFields enabled={watermarkEnabled} text={watermarkText} defaultText={value.watermark_default||translateUI("分享者昵称 · 平台名称")} onEnabled={setWatermarkEnabled} onText={setWatermarkText}/>
        <div className="library-share-link-add"><label>{translateUI("外链有效期")}<select aria-label={translateUI("知识库外链有效期")} value={days??"permanent"} onChange={e=>setDays(e.target.value==="permanent"?null:Number(e.target.value))}><option value="1">{translateUI("1 天")}</option><option value="7">{translateUI("7 天")}</option><option value="30">{translateUI("30 天")}</option><option value="permanent">{translateUI("永久有效")}</option></select></label><button className="primary" disabled={busy} onClick={async()=>{const link=await mutate(`spaces/${id}/sharing/links`,"POST",{days,watermark_enabled:watermarkEnabled,watermark_text:watermarkText});if(link){setURL(link.url||serverURL+link.path);setNotice(translateUI("整库只读链接已生成，请复制保存"));}}}>{translateUI("生成整库外链")}</button></div>
        {url&&<div className="copy-row"><input aria-label={translateUI("知识库外部链接")} value={url} readOnly/><button onClick={async()=>{try{await navigator.clipboard.writeText(url);setNotice(translateUI("已复制链接"));}catch{setError(translateUI("复制失败，请选择链接手动复制"));}}}>{translateUI("复制链接")}</button></div>}
        <div className="library-share-links">{value.links.map((link:any)=><ShareLinkRecord key={link.id} link={link} serverURL={serverURL} endpoint={`spaces/${id}/sharing/links/${link.id}`} onChanged={async()=>{await refresh();onChanged();}} onRevoke={async()=>{await request(`spaces/${id}/sharing/links/${link.id}`,"DELETE");setURL("");}}/>)}{!value.links.length&&<p className="muted">{translateUI("尚未生成整库外链。")}</p>}</div>
      </>}
    </div>
  </section></div>;
}

export function PublicLibrary({token}:{token:string}) {
  const [library,setLibrary]=useState<any>(null),[note,setNote]=useState<any>(null),[selected,setSelected]=useState(()=>new URLSearchParams(location.search).get("note")||""),[closed,setClosed]=useState<Set<string>>(new Set()),[siteName,setSiteName]=useState(translateUI("简单笔记")),[error,setError]=useState("");
  useEffect(()=>{let live=true;void request("platform/public").then(value=>{if(live)setSiteName(value.site_name);}).catch(()=>{});return()=>{live=false;};},[]);
  useEffect(()=>{let live=true;async function refresh(){try{const next=await request(`public/libraries/${token}`);if(live){setLibrary(next);setError("");}}catch(e){if(live){setLibrary(null);setNote(null);setError(translateUI((e as Error).message));}}}void refresh();const timer=setInterval(refresh,5000);return()=>{live=false;clearInterval(timer);};},[token]);
  const noteId=library?.notes.some((item:any)=>item.id===selected)?selected:library?.notes[0]?.id;
  const updated=library?.notes.find((item:any)=>item.id===noteId)?.updated_at;
  useEffect(()=>{let live=true;setNote(null);if(!noteId)return;void request(`public/libraries/${token}/notes/${noteId}`).then(value=>{if(live)setNote(value);}).catch(e=>{if(live)setError(translateUI(e.message));});return()=>{live=false;};},[token,noteId,updated]);
  function select(id:string){setSelected(id);history.replaceState(null,"",`/share/library/${token}?note=${encodeURIComponent(id)}`);}
  function branch(parent:string|null,depth=0):React.ReactNode {if(depth>100)return null;return library.catalog.filter((entry:any)=>entry.parent_id===parent).map((entry:any)=>{const item=(entry.kind==="folder"?library.folders:library.notes).find((value:any)=>value.id===entry.id);if(!item)return null;if(entry.kind==="note")return <button key={entry.key} style={{paddingLeft:12+depth*14}} title={item.title} className={noteId===entry.id?"active":""} aria-current={noteId===entry.id?"page":undefined} onClick={()=>select(entry.id)}><Icon name="file" size={15}/><span>{item.title}</span></button>;return <React.Fragment key={entry.key}><button style={{paddingLeft:12+depth*14}} aria-expanded={!closed.has(entry.id)} onClick={()=>setClosed(values=>{const next=new Set(values);next.has(entry.id)?next.delete(entry.id):next.add(entry.id);return next;})}><Icon name={closed.has(entry.id)?"chevron":"down"} size={13}/><Icon name="folder" size={15}/><span>{item.name}</span></button>{!closed.has(entry.id)&&branch(entry.id,depth+1)}</React.Fragment>;});}
  return <main className="public-note public-library"><header className="public-banner"><a className="public-home" href="/" aria-label={translateUI("{0}首页", [siteName])}><span><Icon name="book" size={24}/></span><strong>{siteName}</strong></a><span>{translateUI("知识库只读分享")}</span></header>
    {library&&<ShareWatermark value={library.watermark}/>}
    {library?<div className="public-library-layout"><aside aria-label={translateUI("共享知识库笔记")}><h2>{library.name}</h2>{branch(null)}{!library.notes.length&&<p>{translateUI("暂无可阅读的笔记")}</p>}</aside><article><h1>{note?.title||library.name}</h1>{note?<ReadOnlyNote key={noteId} snapshot={note.snapshot}/>:<p role="status">{error||(noteId?translateUI("正在打开笔记…"):translateUI("此知识库暂无可阅读的笔记。"))}</p>}</article></div>:<p role="status">{error||translateUI("正在打开知识库…")}</p>}
  </main>;
}

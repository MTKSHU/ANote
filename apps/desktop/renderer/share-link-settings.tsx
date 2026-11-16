import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";
import {request} from "./native";
import "./share-link-settings.css";

export function WatermarkFields({enabled,text,defaultText,onEnabled,onText}:{enabled:boolean;text:string;defaultText:string;onEnabled:(value:boolean)=>void;onText:(value:string)=>void}) {
  return <div className="watermark-fields"><label className="watermark-checkbox"><input type="checkbox" aria-label={translateUI("附加水印")} checked={enabled} onChange={event=>onEnabled(event.target.checked)}/><span>{translateUI("附加水印")}</span></label>{enabled&&<input aria-label={translateUI("水印文本")} placeholder={defaultText} value={text} maxLength={160} onChange={event=>onText(event.target.value)}/>}</div>;
}
export function ShareLinkRecord({link,serverURL,endpoint,onChanged,onRevoke}:{link:any;serverURL:string;endpoint?:string;onChanged?:()=>void|Promise<void>;onRevoke?:()=>Promise<void>}) {
  const [enabled,setEnabled]=useState(!!link.watermark_enabled),[text,setText]=useState(link.watermark_text||""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{setEnabled(!!link.watermark_enabled);setText(link.watermark_text||"");},[link.watermark_enabled,link.watermark_text]);
  const url=link.url||(link.path?serverURL+link.path:""),expired=link.expires_at&&Date.parse(link.expires_at)<=Date.now(),state=link.revoked_at?translateUI("已撤销"):expired?translateUI("已过期"):link.expires_at?translateUI("有效"):translateUI("永久有效");
  async function copy(){try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(url);else{input.current?.focus();input.current?.select();if(!document.execCommand("copy"))throw new Error("Copy unavailable");}setNotice(translateUI("已复制链接"));}catch{setNotice(translateUI("复制失败，请选中链接手动复制"));}}
  async function act(operation:()=>Promise<void>){setBusy(true);try{await operation();await onChanged?.();}catch(error){setNotice((error as Error).message);}finally{setBusy(false);}}
  return <section className="share-link-record" data-share-link={link.id}>
    <header><strong>{state}</strong><small>{link.shared_by&&translateUI("分享者：{0} · ", [link.shared_by])}{new Date(link.created_at).toLocaleString(uiLocale())}{translateUI(" 创建")}{link.expires_at?translateUI(" · {0} 到期", [new Date(link.expires_at).toLocaleString(uiLocale())]):""}</small></header>
    {url?<div className="copy-row"><input ref={input} aria-label={translateUI("历史分享链接")} readOnly value={url} onFocus={event=>event.target.select()}/><button disabled={busy} onClick={()=>void copy()}>{translateUI("复制链接")}</button></div>:<p className="muted">{translateUI("旧版记录未保存完整链接，无法还原地址；原链接保持原有效期。")}</p>}
    <div className="share-link-record-actions"><small>{translateUI("水印：")}{link.watermark_enabled?link.watermark_text||translateUI("已开启"):translateUI("未开启")}</small>
      {endpoint&&!link.revoked_at&&<details className="share-link-watermark"><summary role="button">{translateUI("水印设置")}</summary><WatermarkFields enabled={enabled} text={text} defaultText={link.watermark_default||translateUI("分享者昵称 · 平台名称")} onEnabled={setEnabled} onText={setText}/><button disabled={busy} onClick={()=>void act(async()=>{await request(endpoint,"PATCH",{watermark_enabled:enabled,watermark_text:text});setNotice(translateUI("水印设置已保存"));})}>{translateUI("保存水印")}</button></details>}
      {onRevoke&&!link.revoked_at&&<button className="danger-action" disabled={busy} onClick={()=>void act(onRevoke)}>{translateUI("撤销")}</button>}
    </div>{notice&&<p className="share-link-notice" role="status">{notice}</p>}
  </section>;
}
export function ShareWatermark({value}:{value?:{text:string}|null}) {
  const measure=()=>Math.max(1,Math.floor(window.innerWidth/240))*Math.max(1,Math.ceil(window.innerHeight/150));
  const [count,setCount]=useState(measure);
  useEffect(()=>{const resize=()=>setCount(measure());window.addEventListener("resize",resize);return()=>window.removeEventListener("resize",resize);},[]);
  if(!value?.text)return null;
  return <div className="share-watermark" aria-hidden="true" data-watermark-text={value.text}>{Array.from({length:count},(_,index)=><span key={index}>{value.text}</span>)}</div>;
}

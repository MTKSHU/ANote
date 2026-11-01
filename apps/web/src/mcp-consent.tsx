import { t as translateUI } from "@anote/i18n";
import React,{useState,useEffect} from "react";
import {useDialog,DialogClose} from "../../desktop/renderer/dialog";
const labels:Record<string,string>={"notes:read":translateUI("读取与搜索你有权限的笔记"),"notes:write":translateUI("新建及编辑你有权限的笔记"),"assets:read":translateUI("按需读取有权限的附件"),"assets:write":translateUI("上传并引用附件")};
export function McpConsent({id,userName,onClosed}:{id:string;userName:string;onClosed:()=>void}){
  const [value,setValue]=useState<any>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const ref=useDialog(()=>{void decide(false);},{open:true,disabled:busy});
  async function call(method:string,data?:any){const response=await fetch("/api/me/integrations/authorization/"+id,{method,headers:{"Content-Type":"application/json"},...(data?{body:JSON.stringify(data)}:{})});const body=await response.json();if(!response.ok)throw new Error(body.error||body.message||translateUI("授权请求失败"));return body;}
  useEffect(()=>{let current=true;void call("GET").then(next=>{if(current)setValue(next);}).catch(e=>{if(current)setError(translateUI(e.message));});return ()=>{current=false;};},[id]);
  async function decide(allow:boolean){if(busy)return;setBusy(true);setError("");try{const result=await call("POST",{allow});location.assign(result.redirect_uri);}catch(e){setError(translateUI((e as Error).message));setBusy(false);}}
  return <div className="modal academic-modal"><section ref={ref} className="academic-dialog mcp-consent" role="dialog" aria-modal="true" aria-label={translateUI("连接 AI 应用")}>
    <header><h2>{translateUI("连接 AI 应用")}</h2><DialogClose disabled={busy} onClick={()=>{if(value)void decide(false);else onClosed();}}/></header>
    {value?<><p><strong>{value.client_name}</strong>{translateUI(" 希望连接ANote，使用账号 ")}<strong>{userName}</strong>。</p><ul>{value.scopes.map((scope:string)=><li key={scope}>{labels[scope]||scope}</li>)}</ul><p>{translateUI("访问范围始终遵守你的个人、团队及单篇笔记权限。保存前在 AI 聊天中确认差异；可随时在设置中撤销连接。")}</p><p className="muted mcp-redirect">{translateUI("授权结果将返回：")}{new URL(value.redirect_uri).origin}</p><footer><button disabled={busy} onClick={()=>void decide(false)}>{translateUI("取消")}</button><button className="primary" disabled={busy} onClick={()=>void decide(true)}>{busy?translateUI("正在处理…"):translateUI("允许连接")}</button></footer></>:!error?<p>{translateUI("正在读取授权请求…")}</p>:null}
    {error&&<p role="alert" className="note-error">{error}</p>}
    {!value&&error&&<button onClick={onClosed}>{translateUI("返回笔记")}</button>}
  </section></div>;
}

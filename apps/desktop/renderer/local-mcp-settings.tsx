import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useState} from 'react';
import './mcp-connections.css';
export function LocalMcpSettings({onError}:{onError:(error:unknown)=>void}){
  const [value,setValue]=useState<any>(null),[busy,setBusy]=useState(false),[token,setToken]=useState(''),[message,setMessage]=useState(''),[port,setPort]=useState(3112);
  useEffect(()=>{let active=true;void window.anote.localMcpState?.().then(result=>{if(active){setValue(result);setPort(result.port);}}).catch(onError);return()=>{active=false;};},[]);
  const configure=async(input:{enabled?:boolean;rotate?:boolean;port?:number})=>{setBusy(true);if(input.rotate||input.enabled===false)setToken('');const previous=value;if(input.enabled!==undefined)setValue({...value,enabled:input.enabled});try{const result=await window.anote.configureLocalMcp!(input);setValue(result);if(result.token)setToken(result.token);}catch(error){setValue(previous);onError(error);}finally{setBusy(false);}};
  const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);setMessage(translateUI("已复制"));}catch{setMessage(translateUI("请选中内容手动复制"));}};
  return <section className="mcp-connections local-mcp-settings" aria-label={translateUI("本地 AI 工具链")}><h3>{translateUI("本地 MCP")}</h3><p>{translateUI("让本机 AI 工具检索、读取和编辑当前本地目录的笔记。修改先预览，再由你确认提交；笔记和附件不上传服务器。")}</p>
    {value?<><label><input type="checkbox" aria-label={translateUI("启用本地 MCP")} checked={value.enabled} disabled={busy} onChange={event=>void configure({enabled:event.target.checked,port})}/>{translateUI("启用本地 MCP")}</label>
    <p className="muted">{translateUI("仅监听 127.0.0.1。持有令牌的程序可以读取和编辑当前本地目录；切换到服务器模式后停止服务。")}</p>
    <label>{translateUI("端口")}<input type="number" aria-label={translateUI("本地 MCP 端口")} min={1024} max={65535} value={port} disabled={busy} onChange={event=>setPort(Number(event.target.value))}/></label><button disabled={busy||port===value.port} onClick={()=>void configure({port})}>{translateUI("应用端口")}</button>
    {value.error&&<p role="alert">{translateUI("本地 MCP 未能启动：")}{value.error}</p>}
    {value.running&&<><label>{translateUI("接入地址")}<input aria-label={translateUI("本地 MCP 接入地址")} readOnly value={value.endpoint} onFocus={event=>event.target.select()}/></label><button onClick={()=>void copy(value.endpoint)}>{translateUI("复制地址")}</button><button onClick={()=>void copy(`[mcp_servers.anote_local]\nurl = ${JSON.stringify(value.endpoint)}\nbearer_token_env_var = "ANOTE_LOCAL_MCP_TOKEN"\n`)}>{translateUI("复制连接配置")}</button><button disabled={busy} onClick={()=>void configure({rotate:true})}>{translateUI("重置本地 MCP 令牌")}</button></>}
    {token&&<section className="mcp-token-created"><strong>{translateUI("令牌仅本次显示，请现在保存")}</strong><input aria-label={translateUI("本地 MCP 令牌（仅本次显示）")} readOnly value={token} autoComplete="off" spellCheck={false} onFocus={event=>event.target.select()}/><button onClick={()=>void copy(token)}>{translateUI("复制令牌")}</button><button onClick={()=>setToken('')}>{translateUI("隐藏令牌")}</button></section>}
    <p className="muted">{translateUI("在 AI 工具运行环境设置 ANOTE_LOCAL_MCP_TOKEN，并以 Authorization: Bearer 令牌连接。远程 SSH 可用隧道转发该本机地址。支持现有附件读取；新附件请先在客户端中添加。")}</p>{message&&<p role="status">{message}</p>}</>:<p>{translateUI("正在读取本地 MCP 设置…")}</p>}
  </section>;
}

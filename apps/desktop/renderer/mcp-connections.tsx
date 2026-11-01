import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React,{useEffect,useState} from "react";
import {request} from "./native";

export function McpConnections({onError}:{onError:(error:unknown)=>void}){
  const [value,setValue]=useState<any>(null),[copy,setCopy]=useState(""),[busy,setBusy]=useState("");
  async function refresh(){try{setValue(await request("me/integrations"));}catch(error){onError(error);}}
  useEffect(()=>{void refresh();},[]);
  useEffect(()=>{if(!copy)return;const timer=setTimeout(()=>setCopy(""),2400);return ()=>clearTimeout(timer);},[copy]);
  async function copyText(kind:string){
    if(!value)return;
    const content=kind===translateUI("地址")?value.endpoint:kind===translateUI("Codex 配置")?`[mcp_servers.anote]\nurl = ${JSON.stringify(value.endpoint)}\n`:JSON.stringify({mcpServers:{anote:{type:"http",url:value.endpoint}}},null,2);
    try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(content);else{const el=document.createElement("textarea");el.value=content;document.body.append(el);el.select();const ok=document.execCommand("copy");el.remove();if(!ok)throw new Error(translateUI("复制失败"));}setCopy(translateUI("{0}已复制", [kind]));}catch{setCopy(translateUI("无法自动复制，请手动复制接入地址"));}
  }
  return <section className="mcp-connections" aria-label={translateUI("AI工具链")}>
    <h3>{translateUI("AI工具链")}</h3>
    <p className="muted">Codex · ChatGPT · Copilot</p>
    <p>{translateUI("连接后按任务访问你已有权限的笔记。编辑先展示差异，再在聊天中确认保存。")}</p>
    {value?<>
      <div className="mcp-address"><label>{translateUI("接入地址")}<input aria-label={translateUI("MCP 接入地址")} readOnly value={value.endpoint} onFocus={event=>event.target.select()}/></label><button onClick={()=>void copyText(translateUI("地址"))}>{translateUI("复制地址")}</button><button onClick={()=>void copyText(translateUI("Codex 配置"))}>{translateUI("复制 Codex 配置")}</button><button onClick={()=>void copyText(translateUI("配置"))}>{translateUI("复制 Copilot 配置")}</button></div>
      <p className="muted">{translateUI("Codex 桌面端：名称填写 ANote，选择“流式 HTTP”并填写地址；Bearer 令牌、标头和环境变量留空。保存并重启连接后，在服务列表点“Authenticate／认证”启动浏览器 OAuth 登录。")}</p>
      <p className="muted">{translateUI("ChatGPT 网页端：通过“插件 → 添加自定义 MCP”配置 OAuth；这是另一种接入入口。Copilot：添加 HTTP MCP 地址，通过浏览器授权。")}</p>
      {copy&&<p role="status">{copy}</p>}
      <div className="mcp-connection-list">
        {value.connections.map((item:any)=><article key={item.id}>
          <div><strong>{item.client_name}</strong><small>{item.revoked_at?translateUI("已撤销"):new Date(item.expires_at).getTime()<=Date.now()?translateUI("已过期"):item.last_used_at?translateUI("最近使用 {0}", [new Date(item.last_used_at).toLocaleString(uiLocale())]):translateUI("尚未使用")}</small></div>
          <button disabled={!!item.revoked_at||busy===item.id} onClick={async()=>{
            setBusy(item.id);
            try{await request("me/integrations/"+item.id,"DELETE");await refresh();}
            catch(error){onError(error);}
            finally{setBusy("");}
          }}>{item.revoked_at?translateUI("已撤销"):translateUI("撤销连接")}</button>
        </article>)}
        {!value.connections.length&&<p className="muted">{translateUI("暂无已授权的 AI 应用。")}</p>}
      </div>
    </>:<p className="muted">{translateUI("正在读取接入信息…")}</p>}
  </section>;
}

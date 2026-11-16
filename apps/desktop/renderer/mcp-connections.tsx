import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";
import {request} from "./native";
import "./mcp-connections.css";

const permissions=[['notes:read',translateUI("读取笔记")],['notes:write',translateUI("编辑笔记")],['assets:read',translateUI("读取附件")],['assets:write',translateUI("上传附件")]] as const;
type CreatedToken={id:string;token:string;name:string;expires_at:string};

export function McpConnections({onError}:{onError:(error:unknown)=>void}){
  const [value,setValue]=useState<any>(null),[copy,setCopy]=useState(""),[busy,setBusy]=useState("");
  const [name,setName]=useState(""),[days,setDays]=useState(30),[scopes,setScopes]=useState<string[]>(['notes:read','assets:read']),[created,setCreated]=useState<CreatedToken|null>(null);
  const tokenPanel=useRef<HTMLDetailsElement>(null);
  async function refresh(){try{setValue(await request("me/integrations"));}catch(error){onError(error);}}
  useEffect(()=>{void refresh();},[]);
  useEffect(()=>{if(!copy)return;const timer=setTimeout(()=>setCopy(""),2400);return ()=>clearTimeout(timer);},[copy]);
  async function copyText(kind:string,explicit?:string){
    if(!value)return;
    const content=explicit??(kind===translateUI("地址")?value.endpoint:kind===translateUI("Codex 配置")?`[mcp_servers.simplenote]\nurl = ${JSON.stringify(value.endpoint)}\n`:JSON.stringify({mcpServers:{simplenote:{type:"http",url:value.endpoint}}},null,2));
    try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(content);else{const el=document.createElement("textarea");try{el.value=content;document.body.append(el);el.select();if(!document.execCommand("copy"))throw new Error(translateUI("复制失败"));}finally{el.remove();}}setCopy(translateUI("{0}已复制", [kind]));}catch{setCopy(translateUI("无法自动复制，请选中内容手动复制"));}
  }
  return <section className="mcp-connections" aria-label={translateUI("AI工具链")}>
    <h3>{translateUI("AI工具链")}</h3>
    <p className="muted">Codex · ChatGPT · Copilot</p>
    <p>{translateUI("连接后按任务访问你已有权限的笔记。编辑先展示差异，再在聊天中确认保存。")}</p>
    {value?<>
      <div className="mcp-address"><label>{translateUI("接入地址")}<input aria-label={translateUI("MCP 接入地址")} readOnly value={value.endpoint} onFocus={event=>event.target.select()}/></label><button onClick={()=>void copyText(translateUI("地址"))}>{translateUI("复制地址")}</button><button onClick={()=>void copyText(translateUI("Codex 配置"))}>{translateUI("复制 Codex 配置")}</button><button onClick={()=>void copyText(translateUI("配置"))}>{translateUI("复制 Copilot 配置")}</button></div>
      <p className="muted">{translateUI("使用 OAuth 的 Codex 桌面端：名称填写 ANote，选择“流式 HTTP”并填写地址；Bearer 令牌、标头和环境变量留空。保存并重启连接后，在服务列表点“Authenticate／认证”启动浏览器 OAuth 登录。")}</p>
      <p className="muted">{translateUI("平台升级编辑格式不会使仍有效的认证失效。若客户端缓存了旧 schema，请刷新工具定义或重新连接，并调用 get_editor_rules 获取当前版本；不需要反复登录。重新读取笔记、展示新预览后再保存，不要自动重放旧写入。")}</p>
      <p className="muted">{translateUI("ChatGPT 网页端：通过“插件 → 添加自定义 MCP”配置 OAuth；这是另一种接入入口。Copilot：添加 HTTP MCP 地址，通过浏览器授权。")}</p>
      <details className="mcp-personal-token" ref={tokenPanel} onToggle={event=>{if(!event.currentTarget.open)setCreated(null);}}>
        <summary>{translateUI("远程 SSH / 无浏览器客户端令牌")}</summary>
        <p className="muted">{translateUI("为运行 AI agent 的远程环境创建独立令牌，在 HTTP 请求中使用 Authorization: Bearer 令牌。只授予所需权限，令牌可随时撤销；不会获得你原本没有的笔记权限。")}</p>
        <form onSubmit={async event=>{
          event.preventDefault();setBusy('create-token');setCreated(null);
          try{const token=await request('me/integrations/tokens','POST',{name,expires_in_days:days,scopes});if(tokenPanel.current?.open)setCreated(token);setName('');await refresh();}
          catch(error){onError(error);}finally{setBusy('');}
        }}>
          <div className="mcp-token-fields"><label>{translateUI("令牌名称")}<input aria-label={translateUI("MCP 令牌名称")} value={name} maxLength={80} placeholder={translateUI("例如：实验室 SSH")} required onChange={event=>setName(event.target.value)}/></label><label>{translateUI("有效期")}<select aria-label={translateUI("MCP 令牌有效期")} value={days} onChange={event=>setDays(Number(event.target.value))}><option value={7}>{translateUI("7 天")}</option><option value={30}>{translateUI("30 天")}</option><option value={90}>{translateUI("90 天")}</option></select></label></div>
          <fieldset><legend>{translateUI("令牌权限")}</legend>{permissions.map(([scope,label])=><label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event=>setScopes(current=>event.target.checked?[...current,scope]:current.filter(value=>value!==scope))}/>{label}</label>)}</fieldset>
          <p className="muted">{translateUI("AI 获取规则和读取笔记需要“读取笔记”；上传附件还需同时选择“编辑笔记”。")}</p>
          <button type="submit" disabled={!!busy||!name.trim()||!scopes.length}>{busy==='create-token'?translateUI("正在创建…"):translateUI("创建 MCP 令牌")}</button>
        </form>
        {created&&<section className="mcp-token-created" aria-label={translateUI("新建 MCP 令牌")}>
          <strong>{translateUI("令牌仅在本次显示，请现在保存")}</strong><p>“{created.name}{translateUI("”到期时间：")}{new Date(created.expires_at).toLocaleString(uiLocale())}{translateUI("。关闭此界面后无法再次查看。")}</p>
          <label>{translateUI("访问令牌")}<input aria-label={translateUI("MCP 令牌（仅本次显示）")} readOnly value={created.token} autoComplete="off" spellCheck={false} onFocus={event=>event.target.select()}/></label>
          <div><button onClick={()=>void copyText(translateUI("令牌"),created.token)}>{translateUI("复制令牌")}</button><button onClick={()=>void copyText(translateUI("Codex 令牌配置"),`[mcp_servers.anote]\nurl = ${JSON.stringify(value.endpoint)}\nbearer_token_env_var = "ANOTE_MCP_TOKEN"\n`)}>{translateUI("复制 Codex 令牌配置")}</button><button onClick={()=>setCreated(null)}>{translateUI("我已保存，隐藏令牌")}</button></div>
          <p className="muted">{translateUI("在实际运行客户端的环境设置 ANOTE_MCP_TOKEN；配置示例只引用变量名，不包含令牌。令牌用于 MCP，不能用于网页登录。")}</p>
        </section>}
      </details>
      {copy&&<p role="status">{copy}</p>}
      <div className="mcp-connection-list">
        {value.connections.map((item:any)=><article key={item.id}>
          <div><strong>{item.client_name}</strong><span className="mcp-auth-kind">{item.authentication_type==='personal_token'?translateUI("个人令牌"):'OAuth'}</span><small>{item.revoked_at?translateUI("已撤销"):new Date(item.expires_at).getTime()<=Date.now()?translateUI("已过期"):item.last_used_at?translateUI("最近使用 {0}", [new Date(item.last_used_at).toLocaleString(uiLocale())]):translateUI("尚未使用")}{translateUI(" · 到期 ")}{new Date(item.expires_at).toLocaleDateString(uiLocale())}</small><small>{permissions.filter(([scope])=>item.scopes.includes(scope)).map(([,label])=>label).join('、')}</small></div>
          <button disabled={!!item.revoked_at||busy===item.id} onClick={async()=>{
            setBusy(item.id);
            try{await request("me/integrations/"+item.id,"DELETE");await refresh();}
            catch(error){onError(error);}
            finally{setBusy("");}
          }}>{item.revoked_at?translateUI("已撤销"):item.authentication_type==='personal_token'?translateUI("撤销令牌"):translateUI("撤销连接")}</button>
        </article>)}
        {!value.connections.length&&<p className="muted">{translateUI("暂无已授权的 AI 应用。")}</p>}
      </div>
    </>:<p className="muted">{translateUI("正在读取接入信息…")}</p>}
  </section>;
}

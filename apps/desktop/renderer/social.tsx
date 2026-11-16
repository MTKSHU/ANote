import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React,{useEffect,useRef,useState} from "react";
import {request} from "./native";
import {Icon} from "./icons";
import type {ClientUpdateNotification} from "./client-updates";

const changed=()=>window.dispatchEvent(new Event("anote-social-changed"));
export function useSocialBadges(offline:boolean) {
  const [badges,setBadges]=useState({unread:0,requests:0});
  useEffect(()=>{
    if(offline)return;let active=true;
    const refresh=()=>{void request("social/badges").then(value=>{if(active)setBadges(value);}).catch(()=>{});};
    refresh();const timer=setInterval(refresh,30000);window.addEventListener("focus",refresh);window.addEventListener("anote-social-changed",refresh);
    return()=>{active=false;clearInterval(timer);window.removeEventListener("focus",refresh);window.removeEventListener("anote-social-changed",refresh);};
  },[offline]);
  return badges;
}

export function SocialPage({page,userId,offline,onOpenNote,onFriends,onError,headerControls,headerActions,localOnly=false,clientUpdate,onClientUpdate}:{page:string;userId:string;offline:boolean;onOpenNote:(id:string)=>void;onFriends:()=>void;onError:(error:unknown)=>void;headerControls?:React.ReactNode;headerActions?:React.ReactNode;localOnly?:boolean;clientUpdate?:ClientUpdateNotification|null;onClientUpdate?:()=>void}) {
  const [friends,setFriends]=useState<any[]>([]),[messages,setMessages]=useState<any[]>([]),[next,setNext]=useState<number|null>(null),[tab,setTab]=useState("all");
  const [account,setAccount]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[remove,setRemove]=useState<string|null>(null);
  const sequence=useRef(0);
  async function refresh(offset=0){
    if(offline||localOnly)return;
    const current=++sequence.current;
    if(page==="friends"){const result=await request("friends");if(current===sequence.current)setFriends(result);}
    else {const result=await request(`notifications?offset=${offset}&unread=${tab==="unread"}`);if(current===sequence.current){setMessages(previous=>offset?[...previous,...result.items]:result.items);setNext(result.next_offset);}}
  }
  useEffect(()=>{setLoading(true);setNotice("");setRemove(null);if(localOnly){setMessages([]);setNext(null);}let active=true;const update=()=>void refresh().catch(onError).finally(()=>{if(active)setLoading(false);});update();const timer=setInterval(update,30000);window.addEventListener("focus",update);return()=>{active=false;sequence.current++;clearInterval(timer);window.removeEventListener("focus",update);};},[page,tab,offline,localOnly]);
  async function act(path:string,method:string,body?:any){setBusy(true);try{await request(path,method,body);await refresh();changed();}catch(error){onError(error);}finally{setBusy(false);}}
  async function respondInvite(message:any,action:"accept"|"reject") {
    if(busy||offline)return;setBusy(true);
    try{await request("team-invitation-notifications/"+message.id,"PATCH",{action});setNotice(action==="accept"?translateUI("已加入“{0}”，可从用户名菜单切换到该团队。", [message.team_name]):translateUI("已拒绝团队邀请"));await refresh();changed();if(action==="accept")window.dispatchEvent(new Event("anote-note-changed"));}
    catch(error){onError(error);}finally{setBusy(false);}
  }
  const inviteLabels:Record<string,string>={pending:translateUI("等待接受"),accepted:translateUI("已加入团队"),rejected:translateUI("已拒绝邀请"),revoked:translateUI("邀请已撤销"),expired:translateUI("邀请已过期"),unavailable:translateUI("邀请已失效")};
  const accepted=friends.filter(f=>f.status==="accepted"),incoming=friends.filter(f=>f.status==="pending"&&f.requested_by!==userId),outgoing=friends.filter(f=>f.status==="pending"&&f.requested_by===userId);
  const localVisible=page==="notifications"&&clientUpdate&&(tab!=="unread"||!clientUpdate.read);
  const visibleMessages=localOnly?[]:messages;
  const localUnread=!!clientUpdate&&!clientUpdate.read;
  return <div className="academic-browser social-page">
    <header className="academic-page-header"><div className="compact-page-heading">{headerControls}<h1>{page==="friends"?translateUI("好友"):translateUI("消息通知")}</h1></div><div className="workspace-header-actions">{page==="notifications"&&<button disabled={busy||((offline||localOnly)&&!localUnread)} onClick={()=>{clientUpdate?.markRead();if(!offline&&!localOnly)void act("notifications/read","POST",{});}}>{translateUI("全部标为已读")}</button>}{headerActions}</div></header>
    {localOnly?<p className="muted">{translateUI("客户端更新提醒保存在这台设备，连接服务器后可查看平台通知。")}</p>:offline&&<p className="muted">{translateUI("连接平台后可使用服务器通知功能。")}</p>}
    {notice&&<p role="status" className="team-notice">{notice}</p>}
    {page==="friends"?<>
      <form className="friend-request-form" onSubmit={async e=>{e.preventDefault();if(busy||offline)return;setBusy(true);try{await request("friend-requests","POST",{account});setAccount("");setNotice(translateUI("申请已提交；如账号存在且可添加，对方将收到好友申请。"));await refresh();changed();}catch(error){onError(error);}finally{setBusy(false);}}}>
        <label htmlFor="friend-account">{translateUI("添加好友")}</label><input id="friend-account" placeholder={translateUI("准确用户名或已验证邮箱")} value={account} onChange={e=>setAccount(e.target.value)} maxLength={254} required/><button className="primary" disabled={busy||offline}>{translateUI("发送申请")}</button>
      </form>
      <nav className="management-tabs"><button className={tab==="all"?"active":""} onClick={()=>setTab("all")}>{translateUI("好友 ")}{accepted.length}</button><button className={tab==="requests"?"active":""} onClick={()=>setTab("requests")}>{translateUI("好友申请 ")}{incoming.length}</button></nav>
      {tab==="all"?<section aria-label={translateUI("好友列表")}>{accepted.map(friend=><div className="social-row" key={friend.id}><span className="user-avatar">{friend.name.slice(0,1)}</span><span className="social-row-body"><strong>{friend.name}</strong><small>@{friend.username}</small></span>{remove===friend.id?<><button className="danger-action" disabled={busy||offline} onClick={()=>void act("friends/"+friend.id,"DELETE").then(()=>setRemove(null))}>{translateUI("确认移除")}</button><button onClick={()=>setRemove(null)}>{translateUI("取消")}</button></>:<button disabled={busy||offline} onClick={()=>setRemove(friend.id)}>{translateUI("移除好友")}</button>}</div>)}{!loading&&!accepted.length&&<p className="muted">{translateUI("暂无好友。好友关系需双方确认，不会自动开放个人笔记。")}</p>}</section>:<section aria-label={translateUI("好友申请")}>
        {[...incoming,...outgoing].map(friend=><div className="social-row" key={friend.id}><span className="user-avatar">{friend.name.slice(0,1)}</span><span className="social-row-body"><strong>{friend.name}</strong><small>@{friend.username} · {friend.requested_by===userId?translateUI("等待对方确认"):translateUI("申请添加你为好友")}</small></span>{friend.requested_by===userId?<button disabled={busy||offline} onClick={()=>void act("friend-requests/"+friend.id,"PATCH",{action:"cancel"})}>{translateUI("取消申请")}</button>:<><button className="primary" disabled={busy||offline} onClick={()=>void act("friend-requests/"+friend.id,"PATCH",{action:"accept"})}>{translateUI("接受")}</button><button disabled={busy||offline} onClick={()=>void act("friend-requests/"+friend.id,"PATCH",{action:"reject"})}>{translateUI("拒绝")}</button></>}</div>)}{!loading&&!incoming.length&&!outgoing.length&&<p className="muted">{translateUI("暂无好友申请")}</p>}
      </section>}
    </>:<>
      <nav className="management-tabs"><button className={tab==="all"?"active":""} onClick={()=>setTab("all")}>{translateUI("全部")}</button><button className={tab==="unread"?"active":""} onClick={()=>setTab("unread")}>{translateUI("未读")}</button></nav>
      <section aria-label={translateUI("通知列表")}>{localVisible&&<article className={"social-row notification-row client-update-notification"+(!clientUpdate.read?" is-unread":"")} data-client-update={clientUpdate.id}><Icon name="monitor"/><div className="social-row-body"><strong>ANote {clientUpdate.version}{translateUI(" 已可更新")}</strong><span>{translateUI("本设备当前版本 ")}{clientUpdate.state.currentVersion}</span><p>{clientUpdate.state.needsAuth?translateUI("连接服务器后即可下载更新。"):clientUpdate.state.error||translateUI("打开客户端更新查看详情并下载。")}</p><small>{translateUI("本设备客户端提醒")}</small></div><div className="social-row-actions"><button className="primary" onClick={onClientUpdate}>{clientUpdate.state.needsAuth&&clientUpdate.state.status!=="ready"?translateUI("连接服务器后下载更新"):translateUI("查看更新")}</button>{!clientUpdate.read&&<button onClick={clientUpdate.markRead}>{translateUI("标为已读")}</button>}</div></article>}{visibleMessages.map(message=><article className={"social-row notification-row"+(!message.read_at?" is-unread":"")} key={message.id}>
        <Icon name={message.kind==="team_invite"?"users":message.kind.startsWith("friend")?"user-plus":message.kind==="comment"?"comment":"at"}/><div className="social-row-body"><strong>{message.actor_name}{message.kind==="team_invite"?translateUI(" 邀请你加入团队"):message.kind==="mention"?translateUI(" 在笔记中提到了你"):message.kind==="comment"?translateUI(" 发表了新评论"):message.kind==="friend_request"?translateUI(" 申请添加你为好友"):translateUI(" 已接受你的好友申请")}</strong>
        {message.kind==="team_invite"&&<><span>{message.team_name||translateUI("团队邀请")} · {inviteLabels[message.invite_status]||translateUI("邀请已失效")}</span>{message.invite_status==="pending"&&message.invite_expires_at&&<small>{translateUI("有效期至 ")}{new Date(message.invite_expires_at).toLocaleString(uiLocale())}</small>}</>}
        {message.note_title&&<span>{message.note_title}</span>}{message.comment_text&&<p>{message.comment_text}</p>}{message.kind!=="team_invite"&&!message.available&&<span className="muted">{translateUI("该笔记暂不可访问，请联系作者确认分享权限。")}</span>}<small>{new Date(message.created_at).toLocaleString(uiLocale())}</small></div>
        <div className="social-row-actions">{message.kind==="team_invite"?message.invite_status==="pending"&&<><button className="primary" disabled={busy||offline} onClick={()=>void respondInvite(message,"accept")}>{translateUI("接受邀请")}</button><button disabled={busy||offline} onClick={()=>void respondInvite(message,"reject")}>{translateUI("拒绝邀请")}</button></>:message.kind.startsWith("friend")?<button disabled={busy||offline} onClick={()=>{void act("notifications/read","POST",{id:message.id});onFriends();}}>{translateUI("查看好友")}</button>:message.doc_id&&<button disabled={busy||offline} onClick={()=>{void act("notifications/read","POST",{id:message.id});onOpenNote(message.doc_id);}}>{translateUI("打开笔记")}</button>}{!message.read_at&&<button disabled={busy||offline} onClick={()=>void act("notifications/read","POST",{id:message.id})}>{translateUI("标为已读")}</button>}</div>
      </article>)}{!loading&&!visibleMessages.length&&!localVisible&&<p className="muted">{translateUI("暂无")}{tab==="unread"?translateUI("未读"):""}{translateUI("通知")}</p>}{!localOnly&&next!==null&&<button disabled={busy||offline} onClick={()=>void refresh(next).catch(onError)}>{translateUI("加载更多")}</button>}</section>
    </>}
    {loading&&<p className="muted">{translateUI("正在加载…")}</p>}
  </div>;
}

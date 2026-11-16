import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useId,useRef,useState} from "react";
import {Icon} from "./icons";
import {WorkspaceLink} from "./workspace-link";
import "./workspace-account-menu.css";

type WorkspaceTeam={id:string;name:string;archived?:boolean};
type WorkspaceHref=(page:string,team?:string)=>string;

// Close the other identity menu explicitly so keyboard and web clients agree.
function identityToggle(event:React.SyntheticEvent<HTMLDetailsElement>,setOpen:(open:boolean)=>void){
  const current=event.currentTarget;
  setOpen(current.open);
  if(current.open)for(const sibling of document.querySelectorAll<HTMLDetailsElement>("details[data-workspace-identity-menu]"))if(sibling!==current)sibling.open=false;
}

export function WorkspaceAccountMenu({name,email,local,requests,onFriends,onTeams,href,onSettings,onLogout,onCheckUpdates,scope="personal",teams=[],onScope,native=false,onLocalMode,onWorkspaceOpen,switchingWorkspace=false,onWorkspaceError}:{
  name:string;email?:string|null;local:boolean;requests:number;
  onFriends:()=>void;onTeams:()=>void;href:WorkspaceHref;
  onSettings?:()=>void;onLogout?:()=>void;onCheckUpdates?:()=>void;
  scope?:string;teams?:WorkspaceTeam[];onScope?:(scope:string)=>void|Promise<void>;
  native?:boolean;onLocalMode?:()=>void|Promise<void>;onWorkspaceOpen?:()=>void|Promise<void>;switchingWorkspace?:boolean;onWorkspaceError?:(error:unknown)=>void;
}){
  const [open,setOpen]=useState(false),[workspacesOpen,setWorkspacesOpen]=useState(false),[switching,setSwitching]=useState(false),[switchError,setSwitchError]=useState("");
  const menu=useRef<HTMLDetailsElement>(null),workspaceTrigger=useRef<HTMLButtonElement>(null),workspaceChoices=useRef<HTMLDivElement>(null),focusWorkspace=useRef(false),pendingSwitch=useRef(false),workspaceMenuId=useId();
  const busy=switching||switchingWorkspace;
  const initial=Array.from(name.trim())[0]?.toLocaleUpperCase()||"A";
  const close=()=>{if(menu.current)menu.current.open=false;setWorkspacesOpen(false);};
  const run=(action:()=>void)=>{close();action();};
  const openWorkspaces=()=>{
    const selected=workspaceChoices.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)')||workspaceChoices.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if(workspacesOpen){selected?.focus();return;}
    focusWorkspace.current=true;setWorkspacesOpen(true);
    if(onWorkspaceOpen)void Promise.resolve().then(onWorkspaceOpen).catch(error=>onWorkspaceError?.(error));
  };
  async function chooseWorkspace(action:()=>void|Promise<void>){
    if(pendingSwitch.current||switchingWorkspace)return;
    pendingSwitch.current=true;setSwitching(true);setSwitchError("");
    try{await action();close();}
    catch(error){setSwitchError(error instanceof Error?error.message:translateUI("工作空间切换失败，请重试"));onWorkspaceError?.(error);}
    finally{pendingSwitch.current=false;setSwitching(false);}
  }
  // Treat the two menu levels separately so arrows never skip into hidden choices.
  useEffect(()=>{
    const root=menu.current;if(!root)return;
    const avatar=root.querySelector<HTMLElement>("summary");
    const stop=(event:KeyboardEvent)=>{event.preventDefault();event.stopPropagation();};
    const focusItem=(items:HTMLElement[],event:KeyboardEvent)=>{
      if(!items.length)return;
      const index=items.indexOf(document.activeElement as HTMLElement);
      const next=event.key==="Home"?0:event.key==="End"?items.length-1:index<0?(event.key==="ArrowUp"?items.length-1:0):event.key==="ArrowUp"?(index+items.length-1)%items.length:(index+1)%items.length;
      items[next].focus();
    };
    const navigate=(event:KeyboardEvent)=>{
      if(!root.open&&event.target!==avatar)return;
      const inChoices=workspaceChoices.current?.contains(event.target as Node);
      if(event.key==="Escape"){
        stop(event);
        if(workspacesOpen){setWorkspacesOpen(false);workspaceTrigger.current?.focus();}
        else{close();avatar?.focus();}
      }else if((inChoices||event.target===workspaceTrigger.current)&&event.key==="ArrowLeft"&&workspacesOpen){
        stop(event);setWorkspacesOpen(false);workspaceTrigger.current?.focus();
      }else if(event.target===workspaceTrigger.current&&event.key==="ArrowRight"){
        stop(event);openWorkspaces();
      }else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
        stop(event);root.open=true;
        if(inChoices)focusItem([...workspaceChoices.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")],event);
        else{setWorkspacesOpen(false);focusItem([...root.querySelectorAll<HTMLElement>('[data-account-action]:not(:disabled)')],event);}
      }
    };
    const outside=(event:PointerEvent)=>{if(root.open&&!root.contains(event.target as Node))close();};
    const escape=(event:KeyboardEvent)=>{if(root.open&&event.key==="Escape"&&!event.defaultPrevented)navigate(event);};
    const focus=(event:FocusEvent)=>{
      if(root.open&&!root.contains(event.target as Node))close();
      else if(workspacesOpen&&event.target!==workspaceTrigger.current&&!workspaceChoices.current?.contains(event.target as Node))setWorkspacesOpen(false);
    };
    root.addEventListener("keydown",navigate);document.addEventListener("keydown",escape);document.addEventListener("pointerdown",outside);document.addEventListener("focusin",focus);
    return()=>{root.removeEventListener("keydown",navigate);document.removeEventListener("keydown",escape);document.removeEventListener("pointerdown",outside);document.removeEventListener("focusin",focus);};
  },[workspacesOpen,onWorkspaceOpen]);
  useEffect(()=>{
    if(!workspacesOpen||!focusWorkspace.current)return;
    focusWorkspace.current=false;
    (workspaceChoices.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)')||workspaceChoices.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
  },[workspacesOpen]);
  return <details className="workspace-account-menu workspace-avatar-menu" data-workspace-identity-menu name="workspace-identity-menu" ref={menu} onToggle={event=>{identityToggle(event,setOpen);if(!event.currentTarget.open)setWorkspacesOpen(false);}}>
    <summary className="workspace-avatar-trigger" role="button" aria-label={translateUI("用户菜单")} title={name} aria-haspopup="menu" aria-expanded={open}>
      <span className="user-avatar" aria-hidden="true">{initial}</span>
    </summary>
    <div className="workspace-account-popover workspace-user-popover" role="menu" aria-label={translateUI("用户菜单")} onClick={event=>{if((event.target as Element).closest("a")&&menu.current)menu.current.open=false;}}>
      <div className="workspace-account-identity"><strong dir="auto">{name}</strong>{email?.trim()&&<small dir="auto">{email}</small>}{local&&<span>{translateUI("本地个人模式")}</span>}</div>
      <div className="account-menu-utilities workspace-workspace-switch">
        <button ref={workspaceTrigger} type="button" role="menuitem" data-account-action aria-haspopup="menu" aria-expanded={workspacesOpen} aria-controls={workspaceMenuId} onClick={()=>workspacesOpen?setWorkspacesOpen(false):openWorkspaces()}><Icon name="home" size={16}/><span>{translateUI("工作空间切换")}</span><Icon name="chevron" size={14}/></button>
        {workspacesOpen&&<div id={workspaceMenuId} ref={workspaceChoices} className="workspace-account-popover workspace-workspaces-popover" role="menu" aria-label={translateUI("工作空间切换")} aria-busy={busy}>
          <div className="workspace-scope-options">
            {native&&<button type="button" role="menuitemradio" aria-checked={local} disabled={busy||!onLocalMode} onClick={()=>onLocalMode&&void chooseWorkspace(onLocalMode)}><Icon name="monitor" size={16}/><span>{translateUI("本地模式")}</span>{local&&<Icon name="check" size={14}/>}</button>}
            <button type="button" role="menuitemradio" aria-checked={!local&&scope==="personal"} disabled={busy||!onScope} onClick={()=>onScope&&void chooseWorkspace(()=>onScope("personal"))}><Icon name="user" size={16}/><span>{translateUI("个人")}</span>{!local&&scope==="personal"&&<Icon name="check" size={14}/>}</button>
            {teams.map(team=><button type="button" key={team.id} role="menuitemradio" aria-checked={!local&&scope===team.id} disabled={busy||!onScope} onClick={()=>onScope&&void chooseWorkspace(()=>onScope(team.id))}><Icon name="users" size={16}/><span>{team.name}{team.archived?translateUI("（已归档）"):""}</span>{!local&&scope===team.id&&<Icon name="check" size={14}/>}</button>)}
          </div>
          {busy&&<div className="workspace-switch-status" role="status">{translateUI("正在切换工作空间…")}</div>}
          {switchError&&<div className="workspace-switch-error" role="alert">{switchError}</div>}
        </div>}
      </div>
      <div className="account-menu-utilities workspace-account-management">
        <WorkspaceLink href={href("friends")} role="menuitem" data-account-action onNavigate={onFriends}><Icon name="user-plus" size={16}/><span>{translateUI("好友管理")}</span>{requests>0&&<small>{requests}</small>}</WorkspaceLink>
        <WorkspaceLink href={href("teams")} role="menuitem" data-account-action onNavigate={onTeams}><Icon name="users" size={16}/><span>{translateUI("团队管理")}</span></WorkspaceLink>
      </div>
      {onCheckUpdates&&<div className="account-menu-utilities workspace-account-shortcuts"><button type="button" role="menuitem" data-account-action onClick={()=>run(onCheckUpdates)}><Icon name="sync" size={16}/><span>{translateUI("检查更新")}</span></button></div>}
      {(onSettings||onLogout)&&<div className="account-menu-utilities">
        {onSettings&&<button type="button" role="menuitem" data-account-action onClick={()=>run(onSettings)}><Icon name="settings" size={16}/><span>{translateUI("设置")}</span></button>}
        {onLogout&&<button type="button" role="menuitem" data-account-action className="account-menu-sign-out" onClick={()=>run(onLogout)}><Icon name="logout" size={16}/><span>{translateUI("退出登录")}</span></button>}
      </div>}
    </div>
  </details>;
}

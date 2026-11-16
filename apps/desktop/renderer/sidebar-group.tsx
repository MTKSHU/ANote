import { t as translateUI } from "@anote/i18n";
import React,{useId} from "react";
import {useSidebarVisibility} from "./sidebar-visibility";
import {Icon} from "./icons";

export function SidebarGroup({serverURL,userId,name,label,heading,children}:{serverURL:string;userId:string;name:string;label:string;heading:React.ReactNode;children:React.ReactNode}) {
  const [collapsed,setCollapsed]=useSidebarVisibility(serverURL,userId,`group:${name}`),id=useId();
  return <>
    <div className="sidebar-group-heading">{heading}<button className="sidebar-group-toggle" aria-label={(collapsed?translateUI("展开"):translateUI("折叠"))+label} title={(collapsed?translateUI("展开"):translateUI("折叠"))+label} aria-expanded={!collapsed} aria-controls={id} onClick={()=>setCollapsed(!collapsed)}><Icon name="chevron" size={14} className={collapsed?"":"sidebar-group-expanded"}/></button></div>
    <div className="sidebar-group-content" id={id} hidden={collapsed}>{children}</div>
  </>;
}

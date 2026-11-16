import { t as translateUI } from "@anote/i18n";
import React,{useState} from "react";
import {useDisclosureMenu} from "./disclosure-menu";
import {Icon} from "./icons";
export type PageWidth="normal"|"wide"|"full";
export function usePageWidth(server:string,user:string) {
  const key=`anote:page-width:${server}:${user}`;
  function read():PageWidth{try{const value=localStorage.getItem(key);return value==="wide"||value==="full"?value:"normal";}catch{return "normal";}}
  const [state,setState]=useState(()=>({key,value:read()}));
  const width=state.key===key?state.value:read();
  function setWidth(value:PageWidth){setState({key,value});try{localStorage.setItem(key,value);}catch{}}
  return [width,setWidth] as const;
}
export function PageWidthMenu({value,onChange}:{value:PageWidth;onChange:(value:PageWidth)=>void}) {
  const menu=useDisclosureMenu();
  return <details className="page-width-menu" ref={menu}><summary role="button" aria-label={translateUI("页宽")} title={translateUI("正文页宽")}><Icon name="page-width"/><span>{translateUI("页宽")}</span></summary><div role="menu" aria-label={translateUI("正文页宽")}>
    {([["normal",translateUI("常规")],["wide",translateUI("较宽")],["full",translateUI("全宽")]] as const).map(([key,label])=><button key={key} role="menuitemradio" aria-checked={key===value} onClick={()=>{onChange(key);menu.current?.removeAttribute("open");}}><span>{label}</span>{key===value&&<Icon name="check" size={15}/>}</button>)}
  </div></details>;
}

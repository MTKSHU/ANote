import React from "react";
import {createPortal} from "react-dom";
import {DialogClose,useDialog} from "./dialog";

export function MobilePanel({mobile,open,label,closeLabel,onClose,children}:{mobile:boolean;open:boolean;label:string;closeLabel:string;onClose:()=>void;children:React.ReactNode}) {
  const ref=useDialog<HTMLDivElement>(onClose,{open:mobile&&open});
  if(!open)return null;
  if(!mobile)return <>{children}</>;
  return createPortal(<div className="modal mobile-workspace-overlay" onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className="mobile-workspace-panel" ref={ref} role="dialog" aria-label={label} aria-modal="true">
      <header><strong>{label}</strong><DialogClose onClick={onClose} label={closeLabel}/></header>
      <div className="mobile-workspace-panel-content">{children}</div>
    </section>
  </div>,document.body);
}

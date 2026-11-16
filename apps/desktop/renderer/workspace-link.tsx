import React from "react";

/** Keep browser context menus, modified clicks and middle clicks native. */
export function WorkspaceLink({onNavigate,children,className="",...props}:Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>,"onClick">&{onNavigate:()=>void}) {
  return <a {...props} className={"workspace-link "+className} onClick={event=>{
    if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    event.preventDefault();onNavigate();
  }}>{children}</a>;
}

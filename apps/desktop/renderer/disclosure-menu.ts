import { useEffect, useRef } from "react";

export function useDisclosureMenu() {
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const root=ref.current;if(!root)return;
    const trigger=root.querySelector<HTMLElement>("summary");
    const buttons=()=>[...root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const close=(restore=false)=>{root.open=false;if(restore)trigger?.focus();};
    const outside=(event:PointerEvent)=>{if(root.open&&!root.contains(event.target as Node))close();};
    const escape=(event:KeyboardEvent)=>{if(root.open&&event.key === "Escape"&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();close(true);}};
    const navigate=(event:KeyboardEvent)=>{
      if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
      if(!root.open && event.target!==trigger)return;
      const targets=buttons();if(!targets.length)return;
      event.preventDefault();root.open=true;
      const index=targets.indexOf(document.activeElement as HTMLButtonElement);
      const next=event.key === "Home"?0:event.key === "End"?targets.length-1:event.key === "ArrowDown"?(index+1)%targets.length:(index+targets.length-1)%targets.length;
      targets[next].focus();
    };
    const focus=(event:FocusEvent)=>{if(root.open&&!root.contains(event.target as Node))close();};
    root.addEventListener("keydown",navigate);document.addEventListener("keydown",escape);document.addEventListener("pointerdown",outside);document.addEventListener("focusin",focus);
    return()=>{root.removeEventListener("keydown",navigate);document.removeEventListener("keydown",escape);document.removeEventListener("pointerdown",outside);document.removeEventListener("focusin",focus);};
  },[]);
  return ref;
}

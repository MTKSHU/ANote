import {useState} from "react";

function readCollapsed(key:string) {
  try { return localStorage.getItem(key) === "true"; }
  catch { return false; }
}

/** Each panel remembers only manual choices, independently of navigation. */
export function useSidebarVisibility(serverURL:string,userId:string,panel:"sidebar"|"note-list"="sidebar") {
  const prefix = panel === "sidebar" ? "anote:sidebar-collapsed:" : "anote:note-list-collapsed:";
  const key = `${prefix}${serverURL}:${userId}`;
  const [preference,setPreference] = useState(() => ({key,collapsed:readCollapsed(key)}));
  const collapsed = preference.key === key ? preference.collapsed : readCollapsed(key);
  function setCollapsed(value:boolean) {
    setPreference({key,collapsed:value});
    try { localStorage.setItem(key,String(value)); } catch {}
  }
  return [collapsed,setCollapsed] as const;
}

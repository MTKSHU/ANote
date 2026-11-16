import {useState} from "react";
export function useWorkspaceScope(serverURL:string,userId:string,initial:string,local=false) {
  const key=`anote:workspace-scope:${serverURL}:${userId}`;
  const read=()=>{if(local)return "personal";try{return initial||localStorage.getItem(key)||"personal";}catch{return initial||"personal";}};
  const [preference,setPreference]=useState(()=>({key,value:read()}));
  const scope=local?"personal":preference.key===key?preference.value:read();
  function setScope(value:string){const next=local?"personal":value;setPreference({key,value:next});try{localStorage.setItem(key,next);}catch{}}
  return [scope,setScope] as const;
}

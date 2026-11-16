import path from "node:path";
import {readJSON} from "./session-store.mjs";

const cleanTeams=value=>Array.isArray(value)?value.filter(team=>team&&typeof team.id==="string"&&/^[-\w]{1,80}$/.test(team.id)&&typeof team.name==="string").map(({id,name,archived})=>({id,name:name.slice(0,240),archived:!!archived})):[];

/** Server choices remain account-scoped while a separate personal store is open.
 * Only explicit opening of the workspace menu can refresh these over the network. */
export class WorkspaceContexts {
  constructor(){this.teams=new Map();}
  get(session){return {serverURL:session.settings.serverURL,userId:session.settings.user?.id||null,teams:structuredClone(this.teams.get(session.profileKey)||[])};}
  observe(session,value){const next=cleanTeams(value),key=session.profileKey;if(JSON.stringify(this.teams.get(key))===JSON.stringify(next))return false;this.teams.set(key,next);return true;}
  async refresh(session,{network=false,fetch:fetcher=globalThis.fetch}={}){
    const key=session.profileKey,{serverURL,user}=session.settings,token=session.token;
    if(!serverURL||!user?.id)return this.get(session);
    const active=()=>session.profileKey===key;
    if(!this.teams.has(key)){
      const saved=await readJSON(path.join(session.dataRoot||session.profileRoot,"offline","index.json"),null).catch(()=>null);
      if(!active())throw new Error("账号或服务器已切换，请重新打开工作空间菜单");
      if(saved?.identity?.serverURL===serverURL&&saved?.identity?.userId===user.id)this.observe(session,saved.teams);
    }
    if(network&&token&&!session.settings.offline){
      try{
        const response=await fetcher(serverURL+"/api/teams",{headers:{Authorization:"Bearer "+token},redirect:"error",signal:AbortSignal.timeout(8000),cache:"no-store"});
        if(response.ok){const value=await response.json();if(!active())throw new Error("账号或服务器已切换，请重新打开工作空间菜单");this.observe(session,value);}
        else await response.body?.cancel().catch(()=>{});
      }catch(error){if(!active())throw error;}
    }
    if(!active())throw new Error("账号或服务器已切换，请重新打开工作空间菜单");
    return this.get(session);
  }
}

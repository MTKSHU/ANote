import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";

const root="/nas-root",marker=path.join(root,".anote-storage.json");
const hostRoot=process.env.ANOTE_DATA_ROOT,ip=process.env.ANOTE_NAS_IP;
if(!hostRoot||!path.isAbsolute(hostRoot)||hostRoot==="/"||/[\r\n#$"']/.test(hostRoot))throw new Error("Set ANOTE_DATA_ROOT to the absolute host dataset path");
if(!ip||!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)||ip.split('.').some(value=>Number(value)>255))throw new Error("Set ANOTE_NAS_IP to the server LAN IPv4 address");
if((await fs.lstat(root)).isSymbolicLink())throw new Error("Data root cannot be a symlink");
const markerStat=await fs.lstat(marker).catch(error=>{if(error.code!=="ENOENT")throw error;return null;});
if(markerStat?.isSymbolicLink())throw new Error("Storage marker cannot be a symlink");
if(!markerStat&&(await fs.readdir(root)).length)throw new Error("Unrecognized nonempty data root; no files changed");
let state=markerStat?JSON.parse(await fs.readFile(marker,"utf8")):{kind:"anote-nas",version:1,id:randomUUID(),createdAt:new Date().toISOString(),areas:{}};
if(state.kind!=="anote-nas")throw new Error("Unrecognized storage marker");
for(const area of ["database","originals","uploads","previews","clients"]){const target=path.join(root,area),existing=await fs.lstat(target).catch(error=>{if(error.code!=="ENOENT")throw error;return null;});if(existing?.isSymbolicLink())throw new Error("Storage area cannot be a symlink");if(!existing){await fs.mkdir(target,{mode:area==="database"?0o700:0o750});await fs.chown(target,area==="database"?999:1000,area==="database"?999:1000);}}
await fs.writeFile(marker,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const configFile="/workspace/deploy/.env.nas";let configuration=await fs.readFile(configFile,"utf8").catch(error=>{if(error.code!=="ENOENT")throw error;return "";});
for(const [key,value] of Object.entries({ANOTE_DATA_ROOT:hostRoot.replace(/\/$/,""),ANOTE_BIND_IP:ip})){const line=new RegExp("^"+key+"=.*$","m");configuration=line.test(configuration)?configuration.replace(line,key+"="+value):configuration.replace(/\s*$/,"\n")+key+"="+value+"\n";}
await fs.writeFile(configFile,configuration,{mode:0o600});
console.log(JSON.stringify({stage:"prepared",dataRoot:hostRoot,bindAddress:ip}));

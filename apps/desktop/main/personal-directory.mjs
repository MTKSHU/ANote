import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";

const LEGACY=".simple-notes",CURRENT=".anote",JOURNAL=".anote-migration.json",GATE=".anote-directory.lock";
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
const stat=async file=>fs.lstat(file).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
async function regular(file,directory=false){const info=await stat(file);if(!info)return null;if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()))fail("个人笔记迁移拒绝符号链接或特殊文件："+path.basename(file));return info;}
async function read(file){await regular(file);try{return JSON.parse(await fs.readFile(file,"utf8"));}catch(error){if(error.code==="ENOENT")return null;fail("个人笔记迁移记录或目录锁损坏，原文件已保留："+path.basename(file));}}
async function syncDirectory(directory){let handle;try{handle=await fs.open(directory,"r");await handle.sync();}catch(error){if(!["EISDIR","EPERM","EINVAL","ENOTSUP"].includes(error.code))throw error;}finally{await handle?.close();}}
async function atomic(directory,name,value){const file=path.join(directory,name);await regular(file);const temporary=path.join(directory,name+"."+randomUUID()+".tmp"),handle=await fs.open(temporary,"wx",0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+"\n");await handle.sync();}finally{await handle.close();}await regular(file);await fs.rename(temporary,file);await syncDirectory(directory);}
async function claim(file,token){
  for(let attempt=0;attempt<3;attempt++){
    await regular(file);
    try{const handle=await fs.open(file,"wx",0o600);try{await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.sync();}finally{await handle.close();}return;}
    catch(error){if(error.code!=="EEXIST")throw error;}
    const previous=await read(file);
    if(!Number.isSafeInteger(previous?.pid)||previous.pid<=0||typeof previous.token!=="string")fail("个人笔记目录锁无效，未覆盖原锁文件");
    let alive=true;try{process.kill(previous.pid,0);}catch(error){if(error.code==="ESRCH")alive=false;}
    if(alive)fail("此个人笔记目录已被另一客户端打开，请先关闭该客户端");
    const latest=await read(file);if(latest?.token!==previous.token||latest?.pid!==previous.pid)continue;
    await fs.unlink(file).catch(error=>{if(error.code!=="ENOENT")throw error;});
  }
  fail("个人笔记目录正在被其他客户端打开，请稍后重试");
}
async function release(file,token){if((await read(file))?.token===token)await fs.unlink(file).catch(error=>{if(error.code!=="ENOENT")throw error;});}
async function treeIsSafe(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),info=await stat(file);if(!info)continue;if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile()))fail("个人笔记迁移拒绝符号链接或特殊文件："+entry.name);if(info.isDirectory())await treeIsSafe(file);}}
async function identity(directory){const catalog=await read(path.join(directory,"catalog.json"));if(!catalog||catalog.format!=="simple-notes-personal"||![1,2].includes(catalog.version)||typeof catalog.id!=="string"||!/^[a-f0-9-]{36}$/i.test(catalog.id))fail("旧个人笔记目录格式无效，未移动或覆盖原文件");return catalog.id;}
async function complete(directory,current,journal){await atomic(current,".migration.json",{...journal,phase:"complete"});await fs.unlink(path.join(directory,JOURNAL));await syncDirectory(directory);}

/** Hold the ordinary personal lock across the atomic directory rename. */
export async function openPersonalDirectory(directory,token){
  directory=await fs.realpath(directory);
  const legacy=path.join(directory,LEGACY),current=path.join(directory,CURRENT),gate=path.join(directory,GATE),gateToken=randomUUID();
  await claim(gate,gateToken);let ownedLock=null;
  try{
    const old=await regular(legacy,true),next=await regular(current,true),journal=await read(path.join(directory,JOURNAL));
    if(journal&&(journal.format!=="anote-personal-directory-migration"||journal.version!==1||journal.from!==LEGACY||journal.to!==CURRENT||!["prepared","complete"].includes(journal.phase)||typeof journal.catalogId!=="string"))fail("个人笔记迁移标记无效，原目录已保留");
    const oldEntries=old?await fs.readdir(legacy):[],newEntries=next?await fs.readdir(current):[];
    if(oldEntries.length&&newEntries.length)fail("检测到 .anote 和 .simple-notes 均有内容；未合并或覆盖，请保留两份目录并先确认需要打开的笔记");
    if(old&&oldEntries.length){
      // Claim before inspecting or renaming, so an older client observes its
      // normal lock and cannot continue editing a directory being migrated.
      ownedLock=path.join(legacy,"lock.json");await claim(ownedLock,token);
      await treeIsSafe(legacy);const catalogId=await identity(legacy);
      if(journal&&journal.catalogId!==catalogId)fail("迁移标记与旧笔记身份不匹配，原目录已保留");
      if(next)await fs.rmdir(current); // Only the verified empty destination.
      await atomic(directory,JOURNAL,{format:"anote-personal-directory-migration",version:1,from:LEGACY,to:CURRENT,catalogId,phase:"prepared"});
      await fs.rename(legacy,current);ownedLock=path.join(current,"lock.json");await syncDirectory(directory);
      await complete(directory,current,{format:"anote-personal-directory-migration",version:1,from:LEGACY,to:CURRENT,catalogId});
    }else{
      if(journal&&!next)fail("迁移记录存在，但 .anote 目录缺失；未创建空笔记库，请先恢复原目录");
      if(!next)await fs.mkdir(current,{mode:0o700});
      ownedLock=path.join(current,"lock.json");await claim(ownedLock,token);
      if(journal){await treeIsSafe(current);if(await identity(current)!==journal.catalogId)fail("迁移标记与 .anote 笔记身份不匹配，原文件已保留");await complete(directory,current,journal);}
    }
    return {directory,root:current};
  }catch(error){if(ownedLock)await release(ownedLock,token).catch(()=>{});throw error;}
  finally{await release(gate,gateToken);}
}

import {parentPort,workerData,threadId} from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {BackupRepository} from "./incremental-backups.mjs";

const job=workerData;
let capturedAt;
async function readSource(){
  const root=path.resolve(job.sourceRoot);
  async function read(relative){
    const parts=relative.split("/");let current=root;
    for(const part of ["",...parts]){if(part)current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new Error("离线副本目录不能包含符号链接");}
    return JSON.parse(await fs.readFile(current,"utf8"));
  }
  const index=await read("index.json");
  if(index.identity?.serverURL!==job.identity.serverURL||index.identity?.userId!==job.identity.userId)throw new Error("离线副本不属于当前账号或服务器");
  if(index.format!==2||!Array.isArray(index.documents))throw new Error("离线副本索引格式无效");
  const documents=Object.create(null);
  for(const id of index.documents){
    if(typeof id!=="string"||!/^[-\w]{1,80}$/.test(id))throw new Error("离线笔记 ID 无效");
    const record=await read(`documents/${id}.json`);
    if(record.metadata?.id!==id)throw new Error("离线笔记文件缺失或损坏");
    documents[id]=record;
  }
  // format/identity belong to the disk index wrapper, not the captured data.
  const {identity:_identity,format:_format,...data}=index;
  return {...data,format:1,documents};
}
async function run(){try{
  if(!parentPort)throw new Error("备份后台任务必须在线程中运行");
  const repository=new BackupRepository(job.backupRoot,{identity:job.identity,schema:job.schema,claimId:job.claimId});
  let value;
  if(job.operation==="list")value={backups:await repository.manifests()};
  else if(job.operation==="remove")value=await repository.exclusive(async()=>{await repository.remove(job.version);return {backups:await repository.manifests()};});
  else if(job.operation==="capture")value=await repository.exclusive(async()=>{
    const data=await readSource(),versions=await repository.manifests();
    const clock=Math.max(Date.now(),(job.previousClock||0)+1,...versions.map(version=>Number(version.id.split("-")[0])+1));
    if(!Number.isSafeInteger(clock))throw new Error("备份版本时间无效，未清理已有备份");
    const result=await repository.capture(data,job.sourceRoot,{version:clock+"-"+randomUUID(),createdAt:new Date().toISOString(),versions});
    capturedAt=new Date().toISOString();
    const backups=job.prune===false?await repository.manifests():await repository.prune(job.retention);
    return {result,backups,clock,capturedAt};
  });
  else throw new Error("备份后台任务类型无效");
  parentPort.postMessage({type:"result",value:{...value,threadId}});
}catch(error){parentPort?.postMessage({type:"error",message:error.message,code:error.code,capturedAt});}
finally{parentPort?.close();}}
void run();

import {parentPort,workerData,threadId} from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import * as Y from "yjs";
import {initProseMirrorDoc} from "@tiptap/y-tiptap";
import {schema} from "@anote/document-model";

const job=workerData;
const validId=value=>typeof value==="string"&&/^[-\w]{1,80}$/.test(value);
async function safe(relative){
  const root=path.resolve(job.sourceRoot),parts=relative.split("/");
  if(parts.some(part=>!part||part==="."||part==="..")||path.isAbsolute(relative))throw new Error("离线笔记路径无效");
  let current=root;
  for(const part of ["",...parts]){if(part)current=path.join(current,part);if((await fs.lstat(current).catch(()=>null))?.isSymbolicLink())throw new Error("离线笔记目录不能包含符号链接");}
  return current;
}
async function read(relative){return JSON.parse(await fs.readFile(await safe(relative),"utf8"));}
async function write(relative,value){
  const file=await safe(relative);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+"."+randomUUID()+".tmp";
  try{
    const handle=await fs.open(temporary,"wx",0o600);
    try{await handle.writeFile(JSON.stringify(value,null,2)+"\n");await handle.sync();}finally{await handle.close();}
    await safe(relative);await fs.rename(temporary,file);
  }finally{await fs.unlink(temporary).catch(()=>{});}
}
const signature=stat=>`${stat.ino}:${stat.size}:${stat.mtimeMs}`;
async function summaries(file,record,key=job.id){
  const source=signature(await fs.stat(await safe(file))),{ystate:_ystate,snapshot,...thin}=record;
  if(thin.inflight){const {ystate:_pending,...pending}=thin.inflight;thin.inflight=pending;}
  const envelope={format:'anote-document-summary',identity:job.identity,source,record:thin};
  await write(`documents/${key}.preview.json`,{...envelope,format:'anote-document-preview',snapshot});
  await write(`documents/${key}.summary.json`,envelope);
  return {record:thin,source};
}
async function run(){try{
  if(!parentPort)throw new Error("后台笔记保存参数无效");
  if(job.operation==='inspectMany'){
    if(!Array.isArray(job.ids)||!job.ids.length||job.ids.length>500||!job.ids.every(validId))throw new Error('后台笔记目录参数无效');
  }else if(!validId(job.id))throw new Error("后台笔记保存参数无效");
  const index=await read("index.json");
  if(index.identity?.serverURL!==job.identity.serverURL||index.identity?.userId!==job.identity.userId)throw new Error("离线副本不属于当前账号或服务器");
  if(job.operation==='inspectMany'){
    const records=[];
    for(const key of job.ids){
      const file=`documents/${key}.json`,record=await read(file);
      if(record?.metadata?.id!==key||typeof record.ystate!=='string')throw new Error('离线笔记正文文件缺失或身份不匹配');
      records.push({id:key,...await summaries(file,record,key)});
    }
    parentPort.postMessage({type:'result',value:{records,threadId}});return;
  }
  const file=`documents/${job.id}.json`;
  let existing;try{existing=await read(file);}catch(error){if(error.code!=="ENOENT")throw error;}
  if(existing&&existing.metadata?.id!==job.id)throw new Error("离线笔记身份不匹配");
  if(job.operation==='inspect'){
    if(!existing?.ystate)throw new Error('离线笔记正文文件缺失');
    const summary=await summaries(file,existing);parentPort.postMessage({type:'result',value:{...summary,changed:false,threadId}});return;
  }
  let combined,proposal;
  if(job.operation==="merge"){
    if(typeof job.update!=="string"||job.update.length>64*1024*1024)throw new Error("本地笔记正文格式无效或超过 64 MiB");
    const document=new Y.Doc();
    try{
      for(const value of [existing?.ystate,job.update].filter(Boolean))Y.applyUpdate(document,Buffer.from(value,"base64"));
      const prose=initProseMirrorDoc(document.getXmlFragment("default"),schema).doc;prose.check();
      combined={ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"),snapshot:prose.toJSON()};
    }finally{document.destroy();}
    const prepared={stateChanged:combined.ystate!==existing?.ystate,snapshot:combined.snapshot};
    const commit=new Promise(resolve=>parentPort.once("message",message=>resolve(message)));
    parentPort.postMessage({type:"prepared",value:prepared});
    const message=await commit;if(message?.type!=="commit")throw new Error("后台笔记保存确认无效");proposal=message.value;
    if(proposal?.skip){parentPort.postMessage({type:"result",value:{changed:false,threadId}});return;}
  }else if(job.operation==="write"){
    if(!existing?.ystate)throw new Error("离线笔记正文文件缺失");
    combined={ystate:existing.ystate,snapshot:job.record.snapshot??existing.snapshot};proposal={record:job.record};
  }else throw new Error("后台笔记操作无效");
  if(proposal?.record?.metadata?.id!==job.id)throw new Error("后台笔记身份不匹配");
  const record={...proposal.record,...combined};
  if(record.inflight&&!record.inflight.ystate){
    const state=(existing?.inflight?.opId===record.inflight.opId||typeof job.inflightPreviousOpId==="string"&&existing?.inflight?.opId===job.inflightPreviousOpId)?existing.inflight.ystate:job.inflightCurrentState?existing?.ystate:null;
    if(typeof state!=="string")throw new Error("待同步笔记原稿缺失");
    record.inflight={...record.inflight,ystate:state};
  }
  if(proposal.privateCopy){
    if(!proposal.privateCopy.file?.startsWith(`private-backups/${job.id}-`))throw new Error("本地原稿保留路径无效");
    await write(proposal.privateCopy.file,{identity:job.identity,reason:proposal.privateCopy.reason,at:new Date().toISOString(),document:record});
  }
  await write(file,record);
  const summary=await summaries(file,record);
  parentPort.postMessage({type:"result",value:{changed:true,threadId,...summary}});
}catch(error){parentPort?.postMessage({type:"error",message:error.message,code:error.code});}
finally{parentPort?.close();}}
void run();

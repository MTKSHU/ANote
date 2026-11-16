import {Worker} from "node:worker_threads";

// Jobs contain a single-note delta and small record fields. Existing CRDT
// history remains on disk and is never cloned through Electron's main thread.
export async function runDocumentWorker(job,workerFile,prepare){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(workerFile||new URL("./document-worker.mjs",import.meta.url),{workerData:job,resourceLimits:{maxOldGenerationSizeMb:512}});
    let result,received=false,failure;
    worker.on("message",message=>{
      if(message?.type==="prepared"){
        Promise.resolve().then(()=>prepare(message.value)).then(value=>worker.postMessage({type:"commit",value}),error=>{failure=error;void worker.terminate();});
      }else if(message?.type==="result"){result=message.value;received=true;}
      else if(message?.type==="error")failure=Object.assign(new Error(message.message||"后台笔记保存失败"),{code:message.code});
    });
    worker.on("error",error=>{failure=error;});
    worker.on("exit",code=>{
      if(failure)reject(failure);
      else if(code!==0||!received)reject(new Error(`后台笔记保存意外退出（${code}）`));
      else resolve(result);
    });
  });
}

export function stateFreeRecord(record){
  if(!record)return record;
  const {ystate:_ystate,...value}=record;
  if(value.inflight){const {ystate:_pendingState,...pending}=value.inflight;value.inflight=pending;}
  return value;
}

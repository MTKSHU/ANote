import {Worker} from "node:worker_threads";
import {randomUUID} from "node:crypto";
import {cleanupBackupWorkerClaim} from "./incremental-backups.mjs";

// The job contains paths and small options only. The worker reads persisted
// records while OfflineStore.serial holds the account's write barrier.
export async function runBackupWorker(job,workerFile){
  const claimId=randomUUID();
  try{
    return await new Promise((resolve,reject)=>{
      const worker=new Worker(workerFile||new URL("./backup-worker.mjs",import.meta.url),{workerData:{...job,claimId},resourceLimits:{maxOldGenerationSizeMb:512}});
      let result,received=false,failure;
      worker.on("message",message=>{
        if(message?.type==="result"){result=message.value;received=true;}
        else if(message?.type==="error")failure=Object.assign(new Error(message.message||"后台备份失败"),{code:message.code,capturedAt:message.capturedAt});
      });
      worker.on("error",error=>{failure=error;});
      // Await exit, rather than just a result message, so a failed worker's
      // unique filesystem claim is never removed while it can still write.
      worker.on("exit",code=>{
        if(failure)reject(failure);
        else if(code!==0||!received)reject(new Error(`后台备份任务意外退出（${code}）`));
        else resolve(result);
      });
    });
  }finally{await cleanupBackupWorkerClaim(job.backupRoot,claimId);}
}

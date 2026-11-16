import { t as translateUI } from "@anote/i18n";
import type {NativeState} from './native';
import type {IndexeddbPersistence} from 'y-indexeddb';
import {documentDatabaseName} from './document-preview-cache';

// Keep these names in sync with the worker, without importing its Yjs codec
// into this small scheduling module.
const RECOVERY='anote:document-migration-v2-recovery';
const repairedDatabases=new Set<string>(),acknowledged=new WeakSet<IndexeddbPersistence>();
export async function prepareDocumentDatabase(state:NativeState,id:string,encoding:number|undefined,signal:AbortSignal){
  // Encoding 1 must continue to accept old clients until server maintenance
  // explicitly switches this document's protocol to version 2.
  if(encoding!==2||signal.aborted||typeof Worker==='undefined')return;
  await new Promise<void>((resolve,reject)=>{
    const worker=new Worker(new URL('./document-preview-repair.worker.ts',import.meta.url),{type:'module'});
    const finish=(error?:Error)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);worker.terminate();error?reject(error):resolve();};
    const abort=()=>finish(new Error(translateUI("文档已切换")));
    const timer=setTimeout(()=>finish(new Error(translateUI("本机文档整理超时"))),30000);
    signal.addEventListener('abort',abort,{once:true});
    worker.onmessage=event=>{if(event.data?.result?.status==='repaired')repairedDatabases.add(documentDatabaseName(state,id));finish(event.data?.ok?undefined:new Error(event.data?.error||translateUI("本机文档整理失败")));};
    worker.onerror=()=>finish(new Error(translateUI("本机文档整理失败")));
    worker.postMessage({database:documentDatabaseName(state,id)});
  });
}

export async function acknowledgeDocumentRepair(persistence:IndexeddbPersistence){
  await persistence.whenSynced;if(!persistence.db)return;
  const name=persistence.db.name;if(acknowledged.has(persistence)&&!repairedDatabases.has(name))return;
  acknowledged.add(persistence);repairedDatabases.delete(name);
  try{await new Promise<void>((resolve,reject)=>{const transaction=persistence.db!.transaction('custom','readwrite');transaction.objectStore('custom').delete(RECOVERY);transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);});}
  catch(error){acknowledged.delete(persistence);throw error;}
}

import { t as translateUI } from "@anote/i18n";
import * as Y from 'yjs';
import type {IndexeddbPersistence} from 'y-indexeddb';
import {registerDocumentRefresh} from './persistence';

export function sameDocumentUpdate(a:Uint8Array,b:Uint8Array){
  if(a.byteLength!==b.byteLength)return false;
  let offset=0;
  if(a.byteOffset%4===0&&b.byteOffset%4===0){const length=Math.floor(a.length/4),left=new Uint32Array(a.buffer,a.byteOffset,length),right=new Uint32Array(b.buffer,b.byteOffset,length);for(let index=0;index<length;index++)if(left[index]!==right[index])return false;offset=length*4;}
  for(;offset<a.length;offset++)if(a[offset]!==b[offset])return false;
  return true;
}

/** y-indexeddb's refresh reapplies every persisted update since _dbref,
 * including the large update this very live document just wrote. Read the
 * same key range but skip byte-identical updates already observed on this
 * document. Unknown updates from other tabs are always applied. The pinned
 * y-indexeddb cursor/count fields are advanced exactly as fetchUpdates does. */
export function trackDocumentPersistence(document:Y.Doc,persistence:IndexeddbPersistence){
  let known:Uint8Array[]=[];
  const remember=(bytes:Uint8Array,origin:unknown)=>{if(origin!==persistence)known.push(bytes);};document.on('update',remember);
  let refreshing:Promise<void>|null=null;
  const readUpdates=async()=>{
    await persistence.whenSynced;if(!persistence.db)throw new Error(translateUI("本地数据库尚未就绪"));
    const observed=known;known=[];
    try{
      const {updates,keys,count}=await new Promise<{updates:Uint8Array[];keys:IDBValidKey[];count:number}>((resolve,reject)=>{
        const transaction=persistence.db!.transaction('updates','readonly'),store=transaction.objectStore('updates'),range=IDBKeyRange.lowerBound(persistence._dbref),values=store.getAll(range),keys=store.getAllKeys(range),count=store.count();
        transaction.oncomplete=()=>resolve({updates:values.result,keys:keys.result,count:count.result});transaction.onerror=()=>reject(transaction.error||new Error(translateUI("本地缓存读取失败")));transaction.onabort=()=>reject(transaction.error||new Error(translateUI("本地缓存读取被中断")));
      });
      Y.transact(document,()=>{for(const update of updates)if(!observed.some(value=>sameDocumentUpdate(value,update)))Y.applyUpdate(document,update);},persistence,false);
      const last=keys[keys.length-1];if(last!==undefined){if(typeof last!=='number')throw new Error(translateUI("本地缓存索引格式无效"));persistence._dbref=Math.max(persistence._dbref,last+1);}persistence._dbsize=count;
    }catch(error){known=observed.concat(known);throw error;}
  };
  const refresh=()=>{
    if(refreshing)return refreshing;
    const task=readUpdates();refreshing=task;void task.finally(()=>{if(refreshing===task)refreshing=null;}).catch(()=>{});return task;
  };
  const unregister=registerDocumentRefresh(persistence,refresh);
  return {refresh,dispose(){unregister();known=[];document.off('update',remember);}};
}

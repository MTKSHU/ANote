import * as Y from 'yjs';
import {compactDocumentMigrationValues,validateDocumentMigrationValues} from '@anote/document-model/migration-codec';

export const DOCUMENT_REPAIR_MARKER='anote:document-migration-v2';
export const DOCUMENT_REPAIR_RECOVERY='anote:document-migration-v2-recovery';
type ReadState={updates:Uint8Array[];lastKey:IDBValidKey|undefined;repaired:boolean};

/** Run in a worker. Never replace the document from its JSON projection: the
 * original items, comment anchors and unsynced edits all keep their identities. */
export async function repairDocumentDatabase(name:string){
  if(typeof indexedDB.databases!=='function'||!(await indexedDB.databases()).some(database=>database.name===name))return {status:'absent'};
  const database=await new Promise<IDBDatabase>((resolve,reject)=>{const opening=indexedDB.open(name);opening.onupgradeneeded=()=>opening.transaction?.abort();opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>resolve(opening.result);});
  try{
    if(!database.objectStoreNames.contains('updates')||!database.objectStoreNames.contains('custom'))return {status:'unsupported'};
    // A completed repair covers only its checkpoint key. An inactive/older
    // writer may later append a stale full baseline or a new pending update.
    // Inspect keys only on the unchanged fast path, never the update payloads.
    const repaired=await new Promise<boolean>((resolve,reject)=>{
      const transaction=database.transaction(['updates','custom'],'readonly'),marker=transaction.objectStore('custom').get(DOCUMENT_REPAIR_MARKER),last=transaction.objectStore('updates').openKeyCursor(null,'prev');let lastKey:IDBValidKey|undefined;
      last.onsuccess=()=>{lastKey=last.result?.key;};
      transaction.oncomplete=()=>resolve(marker.result?.encoding===2&&lastKey!==undefined&&marker.result.checkpointKey===lastKey);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
    });
    if(repaired)return {status:'already-repaired'};
    for(let attempt=0;attempt<2;attempt++){
      const read=await new Promise<ReadState>((resolve,reject)=>{
        const transaction=database.transaction(['updates','custom'],'readonly'),store=transaction.objectStore('updates'),values=store.getAll(),last=store.openKeyCursor(null,'prev'),marker=transaction.objectStore('custom').get(DOCUMENT_REPAIR_MARKER);let lastKey:IDBValidKey|undefined;
        last.onsuccess=()=>{lastKey=last.result?.key;};
        transaction.oncomplete=()=>resolve({updates:values.result,lastKey,repaired:marker.result?.encoding===2&&lastKey!==undefined&&marker.result.checkpointKey===lastKey});transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
      });
      if(read.repaired)return {status:'already-repaired'};
      if(!read.updates.length)return {status:'empty'};
      const document=new Y.Doc();let original:Uint8Array,compact:Uint8Array,converted=0;
      try{
        for(const update of read.updates)Y.applyUpdate(document,update);
        validateDocumentMigrationValues(document);original=Y.encodeStateAsUpdate(document);
        converted=compactDocumentMigrationValues(document).converted;
        validateDocumentMigrationValues(document);compact=Y.encodeStateAsUpdate(document);
      }finally{document.destroy();}
      const written=await new Promise<boolean>((resolve,reject)=>{
        const transaction=database.transaction(['updates','custom'],'readwrite',{durability:'strict'}),store=transaction.objectStore('updates'),custom=transaction.objectStore('custom'),last=store.openKeyCursor(null,'prev');let matched=false;
        last.onsuccess=()=>{
          // Another tab's write between the read and this transaction must not
          // be removed. Retry with its update included, or keep the old store.
          if(last.result?.key!==read.lastKey)return;
          matched=true;
          // One recoverable pre-compaction state, removed only after the
          // server acknowledges this client's complete collaboration state.
          custom.put({encoding:2,ystate:original,capturedAt:Date.now()},DOCUMENT_REPAIR_RECOVERY);
          const added=store.add(compact);added.onsuccess=()=>{
            if(typeof added.result!=='number'){transaction.abort();return;}
            store.delete(IDBKeyRange.upperBound(added.result,true));
            custom.put({encoding:2,checkpointKey:added.result,capturedAt:Date.now()},DOCUMENT_REPAIR_MARKER);
          };
        };
        transaction.oncomplete=()=>resolve(matched);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
      });
      if(written)return {status:'repaired',converted,beforeBytes:read.updates.reduce((sum,value)=>sum+value.byteLength,0),afterBytes:compact.byteLength};
    }
    return {status:'concurrent-update'};
  }finally{database.close();}
}

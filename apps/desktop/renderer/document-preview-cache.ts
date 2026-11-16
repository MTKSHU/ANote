import { t as translateUI } from "@anote/i18n";
import {schema,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import type {IndexeddbPersistence} from 'y-indexeddb';
import type {NativeState} from './native';
import {cacheMetadata} from './document-save';

const KEY='anote:document-preview:v1';
export type CachedDocumentPreview={format:1;schema:number;owner:string;id:string;snapshot:any;metadata:any;coveredUpdateKey:number;pendingLocal:boolean;capturedAt:string};
export type DocumentPreviewCache={hasUpdates:boolean;value:CachedDocumentPreview|null};
export const documentPreviewOwner=(state:NativeState)=>JSON.stringify([state.serverURL,state.user?.id,state.workspace]);
export const documentDatabaseName=(state:NativeState,id:string)=>`anote:${state.serverURL}:${state.user!.id}:${id}`;

function valid(value:any,state:NativeState,id:string,lastKey:IDBValidKey|undefined):value is CachedDocumentPreview{
  if(value?.format!==1||value.schema!==EDITOR_SCHEMA_VERSION||value.owner!==documentPreviewOwner(state)||value.id!==id||!Number.isSafeInteger(value.coveredUpdateKey)||value.coveredUpdateKey!==lastKey||typeof value.pendingLocal!=='boolean')return false;
  try{schema.nodeFromJSON(value.snapshot).check();return true;}catch{return false;}
}
async function existing(state:NativeState,id:string){
  // Opening a missing database without creating y-indexeddb's stores would
  // break its later upgrade. Listing does not read the large update values.
  if(typeof indexedDB.databases!=='function')return undefined;
  const name=documentDatabaseName(state,id);if(!(await indexedDB.databases()).some(value=>value.name===name))return null;
  return new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name);request.onupgradeneeded=()=>{request.transaction?.abort();};request.onerror=()=>reject(request.error||new Error(translateUI("本机预览读取失败")));request.onsuccess=()=>resolve(request.result);});
}
export async function readDocumentPreview(state:NativeState,id:string):Promise<DocumentPreviewCache>{
  let database:IDBDatabase|null|undefined;
  try{
    database=await existing(state,id);if(!database)return {hasUpdates:database===undefined,value:null};
    if(!database.objectStoreNames.contains('custom')||!database.objectStoreNames.contains('updates'))return {hasUpdates:true,value:null};
    return await new Promise((resolve,reject)=>{
      const transaction=database!.transaction(['updates','custom'],'readonly'),snapshot=transaction.objectStore('custom').get(KEY),last=transaction.objectStore('updates').openKeyCursor(null,'prev');let lastKey:IDBValidKey|undefined;
      last.onsuccess=()=>{lastKey=last.result?.key;};
      transaction.oncomplete=()=>resolve({hasUpdates:lastKey!==undefined,value:valid(snapshot.result,state,id,lastKey)?snapshot.result:null});transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
    });
  }catch{return {hasUpdates:true,value:null};}finally{database?.close();}
}

/** The refresh cursor covers only updates already applied to this live Doc.
 * A subsequent write (including an old client or another tab) advances the
 * auto-increment key and makes this snapshot unusable. No per-keystroke JSON
 * capture or extra update transaction is needed. Never read update values. */
export async function writeDocumentPreview(persistence:IndexeddbPersistence,state:NativeState,id:string,metadata:any,snapshot:any,pendingLocal:boolean){
  await persistence.whenSynced;if(!persistence.db||!metadata)return;
  const coveredUpdateKey = (persistence._dbref - 1);
  if(!Number.isSafeInteger(coveredUpdateKey)||coveredUpdateKey<0)return;
  const value:CachedDocumentPreview={format:1,schema:EDITOR_SCHEMA_VERSION,owner:documentPreviewOwner(state),id,snapshot,metadata:cacheMetadata(metadata),coveredUpdateKey,pendingLocal,capturedAt:new Date().toISOString()};
  await new Promise<void>((resolve,reject)=>{
    const transaction=persistence.db!.transaction(['updates','custom'],'readwrite',{durability:'strict'});transaction.objectStore('custom').put(value,KEY);
    transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error||new Error(translateUI("本机预览保存失败")));transaction.onabort=()=>reject(transaction.error||new Error(translateUI("本机预览保存中断")));
  });
}
export async function forgetDocumentPreview(state:NativeState,id:string){
  const database=await existing(state,id).catch(()=>null);if(!database)return;
  try{if(database.objectStoreNames.contains('custom'))await new Promise<void>((resolve,reject)=>{const transaction=database.transaction('custom','readwrite');transaction.objectStore('custom').delete(KEY);transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);});}finally{database.close();}
}

import {db} from './database.js';
import {HttpException} from '@nestjs/common';
import * as Y from 'yjs';
import {isEncodedPositionMigration,validateDocumentMigrationValues} from '@anote/document-model/migration-codec';

export const DOCUMENT_MIGRATION_ENCODING=2;
function rejectUpdate(message:string):never{
  // Hocuspocus exposes `reason` to the provider; Nest uses the HTTP response.
  // Preserve both so an upgrade fence is not displayed as a login failure.
  throw Object.assign(new HttpException({error:message},409),{reason:message});
}
export function requireStateCapability(encoding:number,capability:unknown){
  if(encoding>1&&(!Number.isFinite(Number(capability))||Number(capability)<DOCUMENT_MIGRATION_ENCODING))
    rejectUpdate('此笔记的协作数据格式已优化，请更新桌面客户端或刷新网页后继续；本地未同步修改请保留。');
}
export function requireCompatibleDocumentUpdate(document:Y.Doc,update:Uint8Array,encoding:number){
  if(encoding!==1&&encoding!==2)rejectUpdate('服务器尚不支持此笔记的协作编码，请联系管理员');
  // A Yjs replacement normally omits its parent and inherits it from origin.
  // That origin may be a GC'd item in this same update, not the live store.
  // Include pending structs too: otherwise a dependent marker could arrive
  // first and silently integrate when a later message supplies its ancestor.
  const decoded=Y.decodeUpdate(update),structs=[...decoded.structs,...(document.store.pendingStructs?Y.decodeUpdateV2(document.store.pendingStructs.update).structs:[])],incoming=new Map<number,(Y.Item|Y.GC|Y.Skip)[]>();
  for(const struct of structs){const rows=incoming.get(struct.id.client)||[];rows.push(struct);incoming.set(struct.id.client,rows);}
  const ends=new Map<number,number[]>();
  for(const [client,rows]of incoming){rows.sort((left,right)=>left.id.clock-right.id.clock||right.length-left.length);let maximum=0;ends.set(client,rows.map(row=>maximum=Math.max(maximum,row.id.clock+row.length)));}
  const lookup=(id:Y.ID):Y.Item|Y.GC|null=>{
    try{const item:Y.Item|Y.GC=Y.getItem(document.store,id) as Y.Item|Y.GC;if(item instanceof Y.Item||item instanceof Y.GC)return item;}catch{/* The origin may exist only in the incoming update. */}
    const rows=incoming.get(id.client);if(rows){let lower=0,upper=rows.length-1,last=-1;while(lower<=upper){const middle=(lower+upper)>>>1;if(rows[middle].id.clock<=id.clock){last=middle;lower=middle+1;}else upper=middle-1;}const prefix=ends.get(id.client)!;for(let index=last;index>=0&&prefix[index]>id.clock;index--){const row=rows[index];if(id.clock<row.id.clock+row.length&&(row instanceof Y.Item||row instanceof Y.GC))return row;}}
    return null;
  };
  type Root={name:string;key:string|null;depth:number};
  const inert:Root={name:'',key:null,depth:0};
  type Descriptor={root:Root}|{kind:'nested'|'same';dependencies:Y.Item[]}|null;
  const cache=new WeakMap<Y.Item,Root|null>();
  const describe=(item:Y.Item):Descriptor=>{
    const parent:any=item.parent;
    if(typeof parent==='string')return {root:{name:parent,key:item.parentSub,depth:0}};
    if(parent instanceof Y.AbstractType){if(!parent._item)return {root:{name:Y.findRootTypeKey(parent),key:item.parentSub,depth:0}};if(parent._item.deleted)return {root:inert};return {kind:'nested',dependencies:[parent._item]};}
    if(parent instanceof Y.ID){const ancestor=lookup(parent);if(ancestor instanceof Y.GC||ancestor instanceof Y.Item&&!(ancestor.content instanceof Y.ContentType))return {root:inert};return ancestor instanceof Y.Item?{kind:'nested',dependencies:[ancestor]}:null;}
    const dependencies:Y.Item[]=[];
    for(const id of [item.origin,item.rightOrigin])if(id){const ancestor=lookup(id);if(!ancestor)return null;if(ancestor instanceof Y.GC)return {root:inert};if(!dependencies.includes(ancestor))dependencies.push(ancestor);}
    return dependencies.length?{kind:'same',dependencies}:null;
  };
  const resolve=(start:Y.Item):Root|null=>{
    // Iterative traversal also handles a long sequence of overwritten values
    // without consuming one JavaScript stack frame per historical item.
    const frames:{item:Y.Item;descriptor?:Descriptor;entered:boolean}[]=[{item:start,entered:false}],visiting=new Set<Y.Item>();
    while(frames.length){const frame=frames[frames.length-1],item=frame.item;
      if(cache.has(item)){visiting.delete(item);frames.pop();continue;}
      if(!frame.entered){frame.entered=true;visiting.add(item);const descriptor=frame.descriptor=describe(item);
        if(!descriptor||'root'in descriptor){cache.set(item,descriptor?.root||null);continue;}
        if(descriptor.dependencies.some(dependency=>visiting.has(dependency))){cache.set(item,null);continue;}
        for(const dependency of descriptor.dependencies)if(!cache.has(dependency))frames.push({item:dependency,entered:false});
      }else{const descriptor=frame.descriptor as Exclude<Descriptor,{root:Root}|null>,roots=descriptor.dependencies.map(dependency=>cache.get(dependency));
        if(roots.some(root=>!root)){cache.set(item,null);continue;}const first=roots[0]!;
        cache.set(item,descriptor.kind==='nested'?{...first,key:null,depth:first.depth+1}:roots.every(root=>root!.name===first.name&&root!.key===first.key&&root!.depth===first.depth)?first:null);
      }
    }
    return cache.get(start)||null;
  };
  const migrationValues:unknown[]=[];let replacementMarker=false;
  for(const struct of structs){
    if(!(struct instanceof Y.Item))continue;
    const known=document.store.clients.get(struct.id.client)?.at(-1);
    if(known&&struct.id.clock+struct.length<=known.id.clock+known.length)continue;
    const content=struct.content.getContent();
    if(encoding===1&&content.some(value=>isEncodedPositionMigration(value)))rejectUpdate('笔记尚未切换协作编码，已保留本地修改，请重新连接后同步');
    const root=resolve(struct);
    // An unresolved new item must not be parked for later integration: its
    // eventual root might be the server-owned migration metadata map.
    if(!root)rejectUpdate('协作更新缺少依赖，已保留本地修改，请重新连接后完整同步');
    if(root.name==='__anote_sync_meta'&&root.depth===0&&root.key==='migrationEncoding'){
      if(content.some(value=>value!==encoding))rejectUpdate('笔记协作编码切换必须先由服务器确认，未知格式不能写入');
      if(content.length&&!Y.isDeleted(decoded.ds,struct.id))replacementMarker=true;
    }
    if(root.name.startsWith('__tiptap_position_migrations:')&&root.depth===0){
      if(encoding===1&&content.some(value=>value instanceof Uint8Array))rejectUpdate('笔记尚未切换协作编码，已保留本地修改，请重新连接后同步');
      migrationValues.push(...content);
    }
  }
  const marker=document.share.has('__anote_sync_meta')?document.getMap('__anote_sync_meta')._map.get('migrationEncoding'):undefined;
  // _map retains its final item after deletion. SyncStep2 also repeats old
  // delete sets, so a tombstone in that slot is not a new marker removal.
  if(encoding===2&&marker&&!marker.deleted&&Y.isDeleted(decoded.ds,marker.id)&&!replacementMarker){
    if(process.env.ANOTE_STATE_POLICY_DIAGNOSTICS==='true'){
      const incomingMarkers=structs.flatMap(struct=>{if(!(struct instanceof Y.Item))return [];const root=resolve(struct);if(root?.name!=='__anote_sync_meta'||root.depth!==0||root.key!=='migrationEncoding')return [];const last=document.store.clients.get(struct.id.client)?.at(-1),content=struct.content.getContent();return [{id:struct.id,known:!!last&&struct.id.clock+struct.length<=last.id.clock+last.length,dsDeleted:Y.isDeleted(decoded.ds,struct.id),valueIs2:content.length===1&&content[0]===2}];});
      console.warn('ANote state marker rejection',JSON.stringify({marker:{id:marker.id,deleted:marker.deleted},liveValueIs2:document.getMap('__anote_sync_meta').get('migrationEncoding')===2,dsContainsMarker:Y.isDeleted(decoded.ds,marker.id),incomingMarkers}));
    }
    rejectUpdate('笔记协作编码标识不能由客户端移除，本地修改已保留');
  }
  if(migrationValues.length){
    // Validate only new migration values, not a clone of the whole live state.
    // The shared codec scans binary primitives without building transfer rows.
    const validation=new Y.Doc();
    try{const store=validation.getMap('__tiptap_position_migrations:validation');validation.transact(()=>{migrationValues.forEach((value,index)=>store.set(String(index),value));});validateDocumentMigrationValues(validation);}
    catch{rejectUpdate('协作迁移记录损坏或格式不受支持，本地修改已保留');}
    finally{validation.destroy();}
  }
}
export function requireLegacyCompatibleUpdate(document:Y.Doc,update:Uint8Array){return requireCompatibleDocumentUpdate(document,update,1);}
export async function requireDocumentStateCapability(id:string,capability:unknown){
  const row=(await db.query('SELECT state_encoding FROM documents WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
  if(row)requireStateCapability(row.state_encoding,capability);return row?.state_encoding||1;
}

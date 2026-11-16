import {Worker} from 'node:worker_threads';
import type {PoolClient} from 'pg';
import {db,transaction} from './database.js';
import {MAX_HISTORY_STATE_BYTES,MAX_HISTORY_CHUNK_BYTES,historyDigest,prepareHistoryStateInProcess,decodeHistoryChunk,type PreparedHistoryChunk,type PreparedHistoryState} from './history-state-codec.js';
import {DocumentWorkerQueue,withDocumentWorker} from './document-worker-queue.js';

const HASH=/^[a-f0-9]{64}$/;
type SQL=Pick<PoolClient,'query'>;
const preparationQueue=new DocumentWorkerQueue({maxQueued:4,maxQueuedBytes:64*1024*1024,timeoutMs:60000},'历史状态准备');
export type HistoryVersionInput={id:string;docId:string;snapshot:unknown;hash:string;state:PreparedHistoryState;author?:string|null;source:string;editorIds?:string[];label?:string;versionName?:string;integrationClient?:string;createdAt?:Date|null;createdAtOffsetMicros?:number};
export type HistoryMigrationResult={id:string;docId:string;status:'converted'|'already-converted'|'missing'|'changed';legacyReleased:boolean;bytes?:number};

/** Large chunking/hashing/compression runs away from the API event loop and
 * before taking database row locks. It never decodes or rewrites Yjs data. */
export async function prepareHistoryState(input:Uint8Array,signal?:AbortSignal):Promise<PreparedHistoryState>{
  if(!(input instanceof Uint8Array)||input.byteLength>MAX_HISTORY_STATE_BYTES)return Promise.reject(new Error('历史协作状态超过存储上限'));
  if(input.byteLength<256*1024)return prepareHistoryStateInProcess(input,signal);
  return preparationQueue.run(()=>{
    const bytes=Uint8Array.from(input);
    return signal=>withDocumentWorker(workerSignal=>prepareHistoryWorker(bytes,workerSignal),signal);
  },{bytes:input.byteLength,signal});
}
function prepareHistoryWorker(bytes:Uint8Array,signal:AbortSignal):Promise<PreparedHistoryState>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./history-state-worker.js',import.meta.url),{workerData:{bytes},transferList:[bytes.buffer as ArrayBuffer],resourceLimits:{maxOldGenerationSizeMb:256}});
    let result:PreparedHistoryState|undefined,failure:Error|undefined;
    const aborted=()=>{failure=new Error('历史状态准备已中止');void worker.terminate();};signal?.addEventListener('abort',aborted,{once:true});
    worker.on('message',message=>{if(message?.type==='result')result=message.value;else if(message?.type==='error')failure=new Error(message.message||'历史状态准备失败');});
    worker.on('error',error=>{failure=error;});
    worker.on('exit',code=>{signal?.removeEventListener('abort',aborted);if(failure)reject(failure);else if(code!==0||!result)reject(new Error('历史状态后台准备异常退出'));else resolve(result);});
  });
}
function validatePrepared(value:PreparedHistoryState){
  if(value.format!=='anote-history-state-v1'||!HASH.test(value.sha256)||!Number.isSafeInteger(value.rawBytes)||value.rawBytes<0||value.rawBytes>MAX_HISTORY_STATE_BYTES||value.chunks.length>32769||value.chunks.reduce((sum,chunk)=>sum+chunk.rawBytes,0)!==value.rawBytes)throw new Error('历史状态清单无效');
  const objects=new Map(value.objects.map(chunk=>[chunk.sha256,chunk]));
  for(const chunk of value.chunks){const object=objects.get(chunk.sha256);if(!HASH.test(chunk.sha256)||!Number.isSafeInteger(chunk.rawBytes)||chunk.rawBytes<1||chunk.rawBytes>MAX_HISTORY_CHUNK_BYTES||object?.rawBytes!==chunk.rawBytes||object.codec!=='deflate-raw-v1'||historyDigest(object.payload)!==object.compressedSha256)throw new Error('历史状态分块清单无效');}
}
async function historyLock(sql:SQL,docId:string){await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))",['history-state:'+docId]);}
async function historyDocumentLock(sql:SQL,docId:string){return !!(await sql.query('SELECT id FROM documents WHERE id=$1 FOR KEY SHARE',[docId])).rowCount;}
function objectFromRow(row:any):PreparedHistoryChunk{return {sha256:row.sha256,rawBytes:Number(row.raw_bytes),codec:row.codec,compressedSha256:row.compressed_sha256,payload:row.payload};}

/** Caller must hold one SQL transaction for objects, manifest and version row.
 * Object data is immutable and document-scoped; no hash-only public endpoint
 * exists. A reference never crosses a note's permission boundary. */
export async function putHistoryState(sql:SQL,docId:string,state:PreparedHistoryState){
  validatePrepared(state);if(!await historyDocumentLock(sql,docId))throw new Error('历史所属笔记不存在');await historyLock(sql,docId);
  if(state.objects.length){
    await sql.query(`INSERT INTO document_history_chunks(doc_id,sha256,raw_bytes,codec,compressed_sha256,payload)
      SELECT $1,item.sha256,item.raw_bytes,'deflate-raw-v1',item.compressed_sha256,item.payload
      FROM unnest($2::text[],$3::integer[],$4::text[],$5::bytea[]) AS item(sha256,raw_bytes,compressed_sha256,payload)
      ON CONFLICT (doc_id,sha256) DO NOTHING`,[docId,state.objects.map(chunk=>chunk.sha256),state.objects.map(chunk=>chunk.rawBytes),state.objects.map(chunk=>chunk.compressedSha256),state.objects.map(chunk=>Buffer.from(chunk.payload))]);
    const existing=(await sql.query('SELECT sha256,raw_bytes,codec,compressed_sha256,payload FROM document_history_chunks WHERE doc_id=$1 AND sha256=ANY($2::text[])',[docId,state.objects.map(chunk=>chunk.sha256)])).rows;
    if(existing.length!==state.objects.length)throw new Error('历史状态分块缺失');
    // Normally prepared and persisted encodings are identical. A future zlib
    // implementation may encode the same raw content differently; validate its
    // existing compressed checksum and raw content instead of overwriting it.
    const planned=new Map(state.objects.map(chunk=>[chunk.sha256,chunk]));
    for(const row of existing){const expected=planned.get(row.sha256)!;if(Number(row.raw_bytes)!==expected.rawBytes)throw new Error('历史状态分块长度不匹配');if(row.compressed_sha256===expected.compressedSha256){if(historyDigest(row.payload)!==row.compressed_sha256)throw new Error('历史状态分块损坏');}else await decodeHistoryChunk(objectFromRow(row));}
  }
  const inserted=await sql.query("INSERT INTO document_history_manifests(doc_id,sha256,raw_bytes,chunk_count,format) VALUES($1,$2,$3,$4,'anote-history-state-v1') ON CONFLICT (doc_id,sha256) DO NOTHING RETURNING sha256",[docId,state.sha256,state.rawBytes,state.chunks.length]);
  if(inserted.rowCount&&state.chunks.length)await sql.query(`INSERT INTO document_history_manifest_chunks(doc_id,manifest_sha256,ordinal,chunk_sha256,raw_bytes)
    SELECT $1,$2,item.ordinal,item.sha256,item.raw_bytes FROM unnest($3::integer[],$4::text[],$5::integer[]) AS item(ordinal,sha256,raw_bytes)`,[docId,state.sha256,state.chunks.map((_,index)=>index),state.chunks.map(chunk=>chunk.sha256),state.chunks.map(chunk=>chunk.rawBytes)]);
  const manifest=(await sql.query('SELECT raw_bytes,chunk_count,format FROM document_history_manifests WHERE doc_id=$1 AND sha256=$2',[docId,state.sha256])).rows[0];
  const references=(await sql.query('SELECT ordinal,chunk_sha256,raw_bytes FROM document_history_manifest_chunks WHERE doc_id=$1 AND manifest_sha256=$2 ORDER BY ordinal',[docId,state.sha256])).rows;
  if(!manifest||manifest.format!==state.format||Number(manifest.raw_bytes)!==state.rawBytes||manifest.chunk_count!==state.chunks.length||references.length!==state.chunks.length||references.some((row,index)=>row.ordinal!==index||row.chunk_sha256!==state.chunks[index].sha256||row.raw_bytes!==state.chunks[index].rawBytes))throw new Error('历史状态清单与原件不一致');
  return state.sha256;
}
export async function writeHistoryVersion(sql:SQL,input:HistoryVersionInput){
  const reference=await putHistoryState(sql,input.docId,input.state);
  await sql.query(`INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,editor_ids,label,version_name,integration_client,created_at,history_state_storage,history_state_manifest_sha256,history_state_verified_at)
    VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,now())+($12::bigint*interval '1 microsecond'),'chunked-v1',$13,now())`,[input.id,input.docId,input.snapshot,input.hash,input.author??null,input.source,input.editorIds||[],input.label||'',input.versionName||'',input.integrationClient??null,input.createdAt||null,input.createdAtOffsetMicros||0,reference]);
}
export async function readHistoryManifest(sql:SQL,docId:string,reference:string){
  if(!HASH.test(reference))throw new Error('历史状态引用无效');
  const manifest=(await sql.query('SELECT raw_bytes,chunk_count,format FROM document_history_manifests WHERE doc_id=$1 AND sha256=$2',[docId,reference])).rows[0];
  if(!manifest||manifest.format!=='anote-history-state-v1'||Number(manifest.raw_bytes)>MAX_HISTORY_STATE_BYTES)throw new Error('历史状态清单缺失或无效');
  const rows=(await sql.query(`SELECT r.ordinal,r.raw_bytes AS reference_bytes,c.sha256,c.raw_bytes,c.codec,c.compressed_sha256,c.payload
    FROM document_history_manifest_chunks r LEFT JOIN document_history_chunks c ON c.doc_id=r.doc_id AND c.sha256=r.chunk_sha256
    WHERE r.doc_id=$1 AND r.manifest_sha256=$2 ORDER BY r.ordinal`,[docId,reference])).rows;
  if(rows.length!==manifest.chunk_count)throw new Error('历史状态清单不完整');
  const buffers:Buffer[]=[];let bytes=0;
  for(const [index,row] of rows.entries()){
    if(row.ordinal!==index||!row.sha256||row.reference_bytes!==row.raw_bytes)throw new Error('历史状态分块引用无效');
    const buffer=await decodeHistoryChunk(objectFromRow(row));buffers.push(buffer);bytes+=buffer.length;if(bytes>MAX_HISTORY_STATE_BYTES)throw new Error('历史状态超过恢复上限');
  }
  const result=Buffer.concat(buffers,bytes);if(bytes!==Number(manifest.raw_bytes)||historyDigest(result)!==reference)throw new Error('历史状态原件校验失败');return result;
}
export async function readHistoryVersionState(sql:SQL,docId:string,versionId:string){
  const row=(await sql.query('SELECT ystate,history_state_storage,history_state_manifest_sha256 FROM document_versions WHERE doc_id=$1 AND id=$2',[docId,versionId])).rows[0];
  if(!row)throw new Error('历史版本不存在');
  if(row.history_state_storage==='chunked-v1')return readHistoryManifest(sql,docId,row.history_state_manifest_sha256);
  if(row.history_state_storage!=='legacy'||!Buffer.isBuffer(row.ystate)||row.ystate.length>MAX_HISTORY_STATE_BYTES)throw new Error('历史状态格式无效');return Buffer.from(row.ystate);
}

/** Copy first, verify, then atomically reference. Legacy release has a second
 * explicit environment gate and is disabled by default. No current state or
 * visible version metadata is changed by this maintenance operation. */
export async function migrateHistoryVersion(docId:string,versionId:string,{releaseLegacy=false,signal}:{releaseLegacy?:boolean;signal?:AbortSignal}={}):Promise<HistoryMigrationResult>{
  if(releaseLegacy&&process.env.ANOTE_HISTORY_ALLOW_LEGACY_RELEASE!=='1')throw new Error('尚未启用旧历史原件释放');
  const original=(await db.query('SELECT ystate,history_state_storage FROM document_versions WHERE doc_id=$1 AND id=$2',[docId,versionId])).rows[0];
  if(!original)return {id:versionId,docId,status:'missing',legacyReleased:false};
  const state=original.ystate?await prepareHistoryState(original.ystate,signal):null;signal?.throwIfAborted();
  return transaction(async sql=>{
    if(!await historyDocumentLock(sql,docId))return {id:versionId,docId,status:'missing',legacyReleased:false};await historyLock(sql,docId);const row=(await sql.query('SELECT ystate,history_state_storage,history_state_manifest_sha256 FROM document_versions WHERE doc_id=$1 AND id=$2 FOR UPDATE',[docId,versionId])).rows[0];
    if(!row)return {id:versionId,docId,status:'missing',legacyReleased:false};
    if(row.history_state_storage==='chunked-v1'){
      const reconstructed=await readHistoryManifest(sql,docId,row.history_state_manifest_sha256);
      if(row.ystate&&historyDigest(row.ystate)!==historyDigest(reconstructed))throw new Error('旧历史原件与分块状态不一致，未释放');
      if(releaseLegacy&&row.ystate)await sql.query('UPDATE document_versions SET ystate=NULL,history_state_legacy_released_at=now(),history_state_verified_at=now() WHERE doc_id=$1 AND id=$2',[docId,versionId]);
      return {id:versionId,docId,status:'already-converted',legacyReleased:!!(releaseLegacy&&row.ystate),bytes:reconstructed.length};
    }
    if(!state||!row.ystate||historyDigest(row.ystate)!==state.sha256)return {id:versionId,docId,status:'changed',legacyReleased:false};
    await putHistoryState(sql,docId,state);const reconstructed=await readHistoryManifest(sql,docId,state.sha256);
    if(!reconstructed.equals(row.ystate))throw new Error('历史分块重建不一致，原件已保留');
    await sql.query("UPDATE document_versions SET history_state_storage='chunked-v1',history_state_manifest_sha256=$3,history_state_verified_at=now(),ystate=CASE WHEN $4 THEN NULL ELSE ystate END,history_state_legacy_released_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE doc_id=$1 AND id=$2",[docId,versionId,state.sha256,releaseLegacy]);
    return {id:versionId,docId,status:'converted',legacyReleased:releaseLegacy,bytes:state.rawBytes};
  });
}
export async function migrateHistoryBatch({limit=1,docId,releaseLegacy=false,signal}:{limit?:number;docId?:string;releaseLegacy?:boolean;signal?:AbortSignal}={}){
  if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('历史整理批量大小无效');
  const rows=(await db.query("SELECT id,doc_id FROM document_versions WHERE ($1::text IS NULL OR doc_id=$1) AND (history_state_storage='legacy' OR ($3::boolean AND ystate IS NOT NULL)) ORDER BY created_at,id LIMIT $2",[docId||null,limit,releaseLegacy])).rows;
  const results:HistoryMigrationResult[]=[];for(const row of rows){signal?.throwIfAborted();results.push(await migrateHistoryVersion(row.doc_id,row.id,{releaseLegacy,signal}));}return results;
}
/** All referenced manifests are validated before mark-and-sweep. Unknown or
 * corrupt formats fail closed instead of freeing potentially live objects. */
export async function collectHistoryObjects(docId:string){
  const referenced=async(sql:SQL)=>(await sql.query('SELECT DISTINCT history_state_manifest_sha256 AS reference,history_state_storage FROM document_versions WHERE doc_id=$1 ORDER BY history_state_storage,reference',[docId])).rows;
  const verified=await referenced(db);
  // Validation may inflate large states. Do this before taking the per-note
  // write gate, then recheck the immutable reference set under that gate.
  for(const row of verified){if(row.history_state_storage==='legacy')continue;if(row.history_state_storage!=='chunked-v1'||!row.reference)throw new Error('未知历史格式，已停止对象回收');await readHistoryManifest(db,docId,row.reference);}
  return transaction(async sql=>{
    if(!await historyDocumentLock(sql,docId))return {manifests:0,chunks:0};await historyLock(sql,docId);
    if(JSON.stringify(await referenced(sql))!==JSON.stringify(verified))throw new Error('历史引用正在变化，请稍后重试回收');
    const manifests=await sql.query('DELETE FROM document_history_manifests m WHERE m.doc_id=$1 AND NOT EXISTS(SELECT 1 FROM document_versions v WHERE v.doc_id=m.doc_id AND v.history_state_manifest_sha256=m.sha256)',[docId]);
    const chunks=await sql.query('DELETE FROM document_history_chunks c WHERE c.doc_id=$1 AND NOT EXISTS(SELECT 1 FROM document_history_manifest_chunks r WHERE r.doc_id=c.doc_id AND r.chunk_sha256=c.sha256)',[docId]);
    return {manifests:manifests.rowCount||0,chunks:chunks.rowCount||0};
  });
}

import {Controller,Inject,Param,Post,Req,Body} from '@nestjs/common';
import type {Request} from 'express';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {Documents} from './documents.js';
import {db,digest,transaction} from './database.js';
import {administrator,documentRole,user} from './auth.js';
import {identifier,fail} from './errors.js';
import {acquireDocument} from './document-lock.js';
import {withStateEncodingLock} from './state-encoding-lock.js';
import {withDocumentWorker} from './document-worker-queue.js';

export function prepareDocumentState(ystate:Buffer,anchors:any[],operation='compact',signal?:AbortSignal):Promise<any>{
  return withDocumentWorker(signal=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./document-state-worker.js',import.meta.url),{workerData:{ystate,anchors,operation},resourceLimits:{maxOldGenerationSizeMb:512}});let result:any,failure:Error|undefined;
    const cancel=()=>{failure=new Error('协作状态整理已中止或超时，原数据保持不变');void worker.terminate();};
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    worker.on('message',value=>{result=value;});worker.on('error',error=>{failure=error;});
    worker.on('exit',code=>{signal.removeEventListener('abort',cancel);if(failure)reject(failure);else if(code!==0||!result?.ok)reject(new Error(result?.error||'协作状态整理失败，原数据保持不变'));else resolve(result);});
  }),signal);
}
export async function compactIdleDocument(documents:Documents,id:string,apply=false,operation='compact',expectedRevision?:string){
  if(apply&&process.env.ANOTE_STATE_COMPACTION_ALLOW_APPLY!=='true')fail(409,'当前实例仅允许预览整理结果，尚未开启实际切换');
  // Expanding the server representation alone cannot downgrade an offline
  // client's IndexedDB/native state. Keep the dual reader and capability
  // fence during application rollback; this path is for isolated recovery.
  if(apply&&operation==='expand'&&process.env.ANOTE_STATE_EXPANSION_OFFLINE_ONLY!=='true')fail(409,'展开仅供隔离恢复验证；客户端协作协议不能直接降级，请保留新版兼容读取与写入保护');
  const source=(await db.query('SELECT id,ystate,state_encoding,state_revision FROM documents WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];if(!source)fail(404,'笔记不存在');
  if(expectedRevision!==undefined&&String(source.state_revision)!==String(expectedRevision))fail(409,'笔记状态已变化，请重新预览整理结果');
  if(operation!=='compact'&&operation!=='expand')fail(400,'整理操作无效');
  const anchors=(await db.query('SELECT anchor FROM comments WHERE doc_id=$1 AND anchor IS NOT NULL',[id])).rows.map(row=>row.anchor);
  const candidate=await prepareDocumentState(source.ystate,anchors,operation),beforeBytes=source.ystate.length,afterBytes=candidate.ystate.byteLength,targetEncoding=operation==='expand'?1:2;
  const report={id,operation,sourceStateRevision:String(source.state_revision),sourceEncoding:source.state_encoding,targetEncoding,beforeBytes,afterBytes,sourceHash:digest(source.ystate),targetHash:candidate.hash,snapshotHash:candidate.snapshotHash,stats:candidate.stats,applied:false,reason:apply?'not-applied':'preview'};
  if(!apply)return report;
  // No identity reset: only replace values, and preserve the original raw state.
  if(operation==='compact'&&source.state_encoding===2&&(!candidate.stats.converted||afterBytes>=beforeBytes*0.9))return {...report,reason:'no-material-reduction'};
  if(operation==='expand'&&source.state_encoding===1&&!candidate.stats.converted)return {...report,reason:'already-legacy'};
  const release=await acquireDocument(id);
  try{return await withStateEncodingLock(id,async()=>{
    const server:any=documents.server.hocuspocus;
    if(server.documents.has(id)||server.loadingDocuments.has(id)||server.unloadingDocuments.has(id))return {...report,reason:'document-active'};
    return transaction(async sql=>{
      const current=(await sql.query('SELECT state_revision,state_encoding FROM documents WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
      if(!current||String(current.state_revision)!==String(source.state_revision))return {...report,reason:'state-changed'};
      await sql.query('INSERT INTO document_state_archives(id,doc_id,source_state_revision,source_encoding,source_hash,snapshot_hash,ystate) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(doc_id,source_state_revision) DO NOTHING',[randomUUID(),id,source.state_revision,source.state_encoding,report.sourceHash,report.snapshotHash,source.ystate]);
      await sql.query('UPDATE documents SET ystate=$2,state_encoding=$3,state_compaction_checked_revision=state_revision+1 WHERE id=$1',[id,Buffer.from(candidate.ystate),targetEncoding]);
      return {...report,applied:true,reason:operation==='expand'?'expanded':'compacted'};
    });
  });}finally{release();}
}

@Controller('api')
export class DocumentStateMaintenanceController{
  constructor(@Inject(Documents) private readonly documents:Documents){}
  @Post('documents/:id/state-maintenance/preview') async preview(@Req() req:Request,@Param('id') input:string,@Body() body:any){const account=await user(req),id=identifier(input);administrator(account);await documentRole(account,id,'manage');return compactIdleDocument(this.documents,id,false,body?.operation||'compact');}
  @Post('documents/:id/state-maintenance/apply') async apply(@Req() req:Request,@Param('id') input:string,@Body() body:any){const account=await user(req),id=identifier(input);administrator(account);await documentRole(account,id,'manage');if(body?.confirm!==true||typeof body?.sourceStateRevision!=='string')fail(400,'缺少整理切换确认和已预览状态版本');return compactIdleDocument(this.documents,id,true,body?.operation||'compact',body.sourceStateRevision);}
}

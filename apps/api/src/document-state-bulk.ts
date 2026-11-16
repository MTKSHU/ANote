import 'reflect-metadata';
import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {stable} from '@anote/sync-core';
import {db,digest,migrate,transaction} from './database.js';
import {prepareDocumentState} from './document-state-maintenance.js';
import {acquireDocumentStateLease} from './document-state-service-lease.js';
import {validateSnapshotRepresentation} from './document-state-snapshot-validation.js';

type Backup={path:string;sha256:string};
type Item={id:string;sourceStateRevision:string;sourceEncoding:number;beforeBytes:number;afterBytes:number;sourceHash:string;targetHash:string;snapshotHash:string;semanticSnapshotHash:string;applied:boolean;reason:string};
type Report={runId:string|null;mode:'apply'|'preview';total:number;converted:number;alreadyEncoded:number;beforeBytes:number;afterBytes:number;activated:boolean;documents:Item[]};

async function verifyBackup(backup?:Backup){
  if(!backup||!path.isAbsolute(backup.path)||!/^[a-f0-9]{64}$/.test(backup.sha256))throw new Error('Apply requires an absolute full pg_dump custom backup path and its SHA-256');
  const stat=await lstat(backup.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<6)throw new Error('The backup must be a regular pg_dump custom file');
  const hash=createHash('sha256');let prefix=Buffer.alloc(0),bytes=0;
  for await(const chunk of createReadStream(backup.path)){const value=Buffer.from(chunk);if(prefix.length<5)prefix=Buffer.concat([prefix,value.subarray(0,5-prefix.length)]);hash.update(value);bytes+=value.length;}
  if(prefix.toString()!=='PGDMP'||hash.digest('hex')!==backup.sha256||bytes!==stat.size)throw new Error('The complete backup hash or pg_dump signature does not match');
  return {hash:backup.sha256,bytes,filename:path.basename(backup.path)};
}

/** Operator-only CLI path. The deployment wrapper must additionally prove that
 * the sole API container exited gracefully; the exclusive DB lease prevents a
 * compatible API or second converter from starting during this operation.
 * No Hocuspocus instance, user token, or public HTTP bypass is constructed. */
export async function convertAllDocumentStates(options:{apply?:boolean;backup?:Backup;signal?:AbortSignal;progress?:(item:Item)=>void|Promise<void>}={}){
  const backup=options.apply?await verifyBackup(options.backup):null;
  const lease=options.apply?await acquireDocumentStateLease('maintenance'):null;
  const report:Report={runId:null,mode:options.apply?'apply':'preview',total:0,converted:0,alreadyEncoded:0,beforeBytes:0,afterBytes:0,activated:false,documents:[]};
  try{
    if(options.apply)await migrate();
    const ids=(await db.query('SELECT id FROM documents ORDER BY id')).rows.map(row=>row.id as string);report.total=ids.length;
    if(options.apply){report.runId=randomUUID();await db.query("INSERT INTO document_state_conversion_runs(id,status,backup_hash,backup_bytes,backup_filename) VALUES($1,'running',$2,$3,$4)",[report.runId,backup!.hash,backup!.bytes,backup!.filename]);}
    for(const id of ids){
      options.signal?.throwIfAborted();
      const source=(await db.query('SELECT id,ystate,snapshot,state_encoding,state_revision FROM documents WHERE id=$1',[id])).rows[0];
      if(!source)throw new Error('Document catalog changed during conversion: '+id);
      const anchors=(await db.query('SELECT anchor FROM comments WHERE doc_id=$1 AND anchor IS NOT NULL',[id])).rows.map(row=>row.anchor);
      const candidate=await prepareDocumentState(source.ystate,anchors,'compact',options.signal);
      const snapshot=validateSnapshotRepresentation(source.snapshot);
      if(candidate.snapshotHash!==snapshot.semanticHash)throw new Error('Stored snapshot and collaboration body differ; original left intact: '+id);
      if(candidate.sourceEncoding!==source.state_encoding)throw new Error('Stored encoding flag and collaboration marker differ; original left intact: '+id);
      const item:Item={id,sourceStateRevision:String(source.state_revision),sourceEncoding:source.state_encoding,beforeBytes:source.ystate.length,afterBytes:source.state_encoding===2?source.ystate.length:candidate.ystate.byteLength,sourceHash:digest(source.ystate),targetHash:source.state_encoding===2?digest(source.ystate):candidate.hash,snapshotHash:snapshot.rawHash,semanticSnapshotHash:snapshot.semanticHash,applied:false,reason:source.state_encoding===2?'already-encoded':'preview'};
      if(source.state_encoding===2)report.alreadyEncoded++;
      else if(options.apply){
        options.signal?.throwIfAborted();
        await transaction(async sql=>{
          const current=(await sql.query('SELECT ystate,snapshot,state_encoding,state_revision FROM documents WHERE id=$1 FOR UPDATE',[id])).rows[0];
          if(!current||String(current.state_revision)!==item.sourceStateRevision||current.state_encoding!==source.state_encoding||digest(current.ystate)!==item.sourceHash||digest(stable(current.snapshot))!==item.snapshotHash)throw new Error('Document changed during conversion; rerun safely: '+id);
          await sql.query('INSERT INTO document_state_archives(id,doc_id,source_state_revision,source_encoding,source_hash,snapshot_hash,ystate) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(doc_id,source_state_revision) DO NOTHING',[randomUUID(),id,source.state_revision,source.state_encoding,item.sourceHash,item.snapshotHash,source.ystate]);
          const archived=(await sql.query('SELECT source_encoding,source_hash,snapshot_hash,ystate FROM document_state_archives WHERE doc_id=$1 AND source_state_revision=$2',[id,source.state_revision])).rows[0];
          if(!archived||archived.source_encoding!==source.state_encoding||archived.source_hash!==item.sourceHash||archived.snapshot_hash!==item.snapshotHash||digest(archived.ystate)!==item.sourceHash)throw new Error('Original archive verification failed: '+id);
          await sql.query('UPDATE documents SET ystate=$2,state_encoding=2,state_compaction_checked_revision=state_revision+1 WHERE id=$1',[id,Buffer.from(candidate.ystate)]);
        });
        item.applied=true;item.reason='converted';report.converted++;
      }
      report.beforeBytes+=item.beforeBytes;report.afterBytes+=item.afterBytes;report.documents.push(item);
      if(report.runId)await db.query('UPDATE document_state_conversion_runs SET report=$2 WHERE id=$1',[report.runId,report]);
      await options.progress?.(item);
    }
    if(options.apply){
      options.signal?.throwIfAborted();
      await transaction(async sql=>{
        // Freeze the final catalog/config verification against direct DB writes.
        await sql.query('LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE');
        const current=(await sql.query('SELECT id,ystate,snapshot,state_encoding FROM documents ORDER BY id')).rows;
        if(current.length!==report.documents.length)throw new Error('Document catalog changed before activation');
        for(let index=0;index<current.length;index++){
          const row=current[index],expected=report.documents[index];
          if(row.id!==expected.id||row.state_encoding!==2||digest(row.ystate)!==expected.targetHash||digest(stable(row.snapshot))!==expected.snapshotHash)throw new Error('Final document verification failed: '+row.id);
        }
        await sql.query('UPDATE document_state_settings SET default_encoding=2,updated_at=now() WHERE singleton');
        report.activated=true;
        await sql.query("UPDATE document_state_conversion_runs SET status='completed',finished_at=now(),report=$2 WHERE id=$1",[report.runId,report]);
      });
    }
    return report;
  }catch(error){
    if(report.runId)await db.query("UPDATE document_state_conversion_runs SET status='failed',finished_at=now(),report=$2 WHERE id=$1",[report.runId,{...report,error:(error as Error).message}]).catch(()=>{});
    throw error;
  }finally{await lease?.release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),allowed=new Set(['--apply','--backup-file','--backup-sha256']);
  try{
    for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new Error('Unknown argument: '+args[i]);if(args[i]!=='--apply'&&(!args[++i]||args[i].startsWith('--')))throw new Error('Missing argument value');}
    const value=(key:string)=>{const index=args.indexOf(key);return index<0?undefined:args[index+1];};
    const controller=new AbortController();for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort(new Error('Conversion interrupted; rerun to resume')));
    const report=await convertAllDocumentStates({apply:args.includes('--apply'),backup:value('--backup-file')?{path:value('--backup-file')!,sha256:value('--backup-sha256')||''}:undefined,signal:controller.signal,progress:item=>{console.log(JSON.stringify({document:item}));}});
    console.log(JSON.stringify({report}));
  }catch(error){console.error(JSON.stringify({error:(error as Error).message}));process.exitCode=1;}
  finally{await db.end();}
}

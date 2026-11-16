import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc,initProseMirrorDoc} from '@tiptap/y-tiptap';
import {schema,canonical,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {findAnchor,resolveAnchor} from '@anote/document-model/anchors';
import {compactDocumentMigrationValues,scanDocumentMigrationEncoding} from '@anote/document-model/migration-codec';
import {stable} from '@anote/sync-core';
import {historyHeavyTodo052} from '../fixtures/history-heavy-todo-052';

test('offline full conversion fences services, resumes, archives every original, includes trash and activates future creators',async()=>{
  assert.equal(process.env.ANOTE_ISOLATED_TESTS,'1');
  const name='bulk055_'+randomUUID().replaceAll('-',''),admin=new Pool({host:'db',user:'anote',database:'anote',password:process.env.DB_PASSWORD}),directory=await mkdtemp(path.join(os.tmpdir(),'anote-bulk055-'));
  let database:any,documents:any,service:any,fixture:any,connection:any;const ydocs:Y.Doc[]=[];
  await admin.query(`CREATE DATABASE "${name}"`);
  try{
    const url=new URL('postgres://anote@db/'+name);url.password=process.env.DB_PASSWORD!;process.env.DATABASE_URL=url.href;process.env.PORT='0';
    database=await import('../../apps/api/dist/database.js');await database.migrate();await import('../../apps/api/dist/teams.js');const {db,digest}=database;
    const {convertAllDocumentStates}=await import('../../apps/api/dist/document-state-bulk.js'),{acquireDocumentStateLease}=await import('../../apps/api/dist/document-state-service-lease.js'),{Documents}=await import('../../apps/api/dist/documents.js'),{syncOffline}=await import('../../apps/api/dist/offline.js');
    await db.query("INSERT INTO users(id,username,name,password_hash) VALUES('owner','owner','Owner','fixture'),('peer','peer','Peer','fixture');INSERT INTO spaces(id,name,kind,created_by) VALUES('book','Book','personal','owner')");
    const owner={id:'owner',username:'owner',name:'Owner',is_admin:false,active:true},peer={id:'peer',username:'peer',name:'Peer',is_admin:false,active:true};
    const value=canonical({type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'原始正文保留'}]}]}),small=prosemirrorJSONToYDoc(schema,value,'default');ydocs.push(small);
    const bytes=Buffer.from(Y.encodeStateAsUpdate(small));
    await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate) VALUES('a-small','book','Small','owner',$1,$2),('b-trash','book','Trash','owner',$1,$2)",[value,bytes]);
    await db.query("UPDATE documents SET deleted_at=now(),deleted_by='owner' WHERE id='b-trash'");
    fixture=historyHeavyTodo052();await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate) VALUES('c-heavy','book','Heavy TODO','owner',$1,$2)",[fixture.snapshot,Buffer.from(fixture.update)]);
    // Simulate an old schema snapshot. Its Yjs body is already interpreted
    // with today's declared canvasHeight default, but raw JSON stays original.
    const legacySnapshot:any={type:'doc',content:[{type:'codeBlock',attrs:{blockId:randomUUID(),language:null},content:[{type:'text',text:'旧版代码块正文保留'}]}]},legacyDocument=prosemirrorJSONToYDoc(schema,legacySnapshot,'default');ydocs.push(legacyDocument);
    await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate) VALUES('d-default-attrs','book','Legacy defaults','owner',$1,$2)",[legacySnapshot,Buffer.from(Y.encodeStateAsUpdate(legacyDocument))]);
    const anchor=findAnchor(fixture.document,initProseMirrorDoc(fixture.document.getXmlFragment('default'),schema).doc.textContent.slice(0,12));assert(anchor);
    await db.query("INSERT INTO comments(id,doc_id,author,body,anchor) VALUES('anchor','c-heavy','owner','保留批注',$1)",[anchor]);
    const before=(await db.query('SELECT * FROM documents ORDER BY id')).rows,originalHashes=new Map(before.map((row:any)=>[row.id,digest(row.ystate)]));
    // The fixture exercises checksum admission only. Deployment QA separately
    // restores a real complete pg_dump before invoking the operator CLI.
    const backupBytes=Buffer.from('PGDMP isolated checksum fixture, not recovery evidence'),backup={path:path.join(directory,'checksum-only.dump'),sha256:createHash('sha256').update(backupBytes).digest('hex')};await writeFile(backup.path,backupBytes);
    await assert.rejects(convertAllDocumentStates({apply:true}),/requires.*backup/);
    await assert.rejects(convertAllDocumentStates({apply:true,backup:{...backup,sha256:'0'.repeat(64)}}),/hash/);
    service=await acquireDocumentStateLease('service');documents=new Documents();await documents.start((_request:any,response:any)=>response.end('test'));
    connection=await documents.server.hocuspocus.openDirectConnection('a-small',{source:'api',migrationEncoding:2});
    assert.equal(documents.server.hocuspocus.documents.has('a-small'),true);
    await assert.rejects(convertAllDocumentStates({apply:true,backup}),/API.*active/);
    await connection.disconnect();connection=undefined;await documents.close();documents=undefined;await service.release();service=undefined;
    const exclusive=await acquireDocumentStateLease('maintenance');try{await assert.rejects(acquireDocumentStateLease('service'),/startup refused/);await assert.rejects(acquireDocumentStateLease('maintenance'),/active/);}finally{await exclusive.release();}
    const mismatched=structuredClone(value);mismatched.content[0].content![0].text='实质正文不一致必须拒绝';
    await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate) VALUES('0-mismatch','book','Mismatch must fail','owner',$1,$2)",[mismatched,bytes]);
    await assert.rejects(convertAllDocumentStates({apply:true,backup}),/collaboration body differ/);assert.equal((await db.query('SELECT count(*)::int AS n FROM document_state_archives')).rows[0].n,0);await db.query("DELETE FROM documents WHERE id='0-mismatch'");
    const preview=await convertAllDocumentStates();assert.equal(preview.total,4);assert.equal(preview.activated,false);assert.equal((await db.query('SELECT count(*)::int AS n FROM document_state_archives')).rows[0].n,0);
    const {validateSnapshotRepresentation}=await import('../../apps/api/dist/document-state-snapshot-validation.js');
    assert.notEqual(validateSnapshotRepresentation(legacySnapshot).rawHash,validateSnapshotRepresentation(legacySnapshot).semanticHash);
    assert.throws(()=>validateSnapshotRepresentation({...legacySnapshot,unknownStoredProperty:'must not silently discard'}),/more than declared/);
    assert.throws(()=>validateSnapshotRepresentation({type:'doc',content:[{...legacySnapshot.content[0],attrs:{...legacySnapshot.content[0].attrs,unknownStoredAttribute:'must not discard'}}]}),/more than declared/);
    await assert.rejects(convertAllDocumentStates({apply:true,backup,progress:item=>{if(item.id==='a-small')throw new Error('test interrupt after committed first note');}}),/test interrupt/);
    assert.equal((await db.query('SELECT default_encoding FROM document_state_settings')).rows[0].default_encoding,1);
    assert.equal((await db.query("SELECT state_encoding FROM documents WHERE id='a-small'")).rows[0].state_encoding,2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM document_state_archives')).rows[0].n,1);
    // A pre-existing archive with the same revision must be verified rather
    // than trusted merely because ON CONFLICT retained it.
    const trash=(await db.query("SELECT state_revision FROM documents WHERE id='b-trash'")).rows[0];
    await db.query("INSERT INTO document_state_archives(id,doc_id,source_state_revision,source_encoding,source_hash,snapshot_hash,ystate) VALUES('invalid-archive','b-trash',$1,1,'invalid','invalid',$2)",[trash.state_revision,Buffer.from('invalid')]);
    await assert.rejects(convertAllDocumentStates({apply:true,backup}),/archive verification failed/);
    assert.equal((await db.query("SELECT state_encoding FROM documents WHERE id='b-trash'")).rows[0].state_encoding,1);await db.query("DELETE FROM document_state_archives WHERE id='invalid-archive'");
    const result=await convertAllDocumentStates({apply:true,backup});assert.equal(result.converted,3);assert.equal(result.alreadyEncoded,1);assert.equal(result.activated,true);assert.equal((await db.query('SELECT default_encoding FROM document_state_settings')).rows[0].default_encoding,2);
    const after=(await db.query('SELECT * FROM documents ORDER BY id')).rows;
    for(const row of after){
      assert.equal(row.state_encoding,2);const old=before.find((item:any)=>item.id===row.id);
      for(const key of ['snapshot','revision','access_revision','title','created_by','last_editor_ids','pending_editor_ids','tags','visibility','archived','deleted_at','deleted_by','updated_at'])assert.deepEqual(row[key],old[key],key+' must stay unchanged');
      const decoded=new Y.Doc();ydocs.push(decoded);Y.applyUpdate(decoded,row.ystate);assert.equal(scanDocumentMigrationEncoding(decoded),2);assert.equal(stable(initProseMirrorDoc(decoded.getXmlFragment('default'),schema).doc.toJSON()),stable(canonical(row.snapshot)));
      if(row.id==='c-heavy')assert.deepEqual(resolveAnchor(decoded,anchor),resolveAnchor(fixture.document,anchor));
      const archive=(await db.query('SELECT * FROM document_state_archives WHERE doc_id=$1',[row.id])).rows;assert.equal(archive.length,1);assert.equal(digest(archive[0].ystate),originalHashes.get(row.id));
    }
    assert(after.find((row:any)=>row.id==='c-heavy').ystate.length<fixture.update.length*.15);
    const repeat=await convertAllDocumentStates({apply:true,backup});assert.equal(repeat.converted,0);assert.equal(repeat.alreadyEncoded,4);assert.equal((await db.query('SELECT count(*)::int AS n FROM document_state_archives')).rows[0].n,4);
    service=await acquireDocumentStateLease('service');documents=new Documents();await documents.start((_request:any,response:any)=>response.end('test'));
    const ordinary=await documents.create(owner,{space_id:'book',title:'Future web note'});assert.equal((await db.query('SELECT state_encoding FROM documents WHERE id=$1',[ordinary.id])).rows[0].state_encoding,2);
    const integrationId=randomUUID();await documents.createIntegration(owner,integrationId,'book',null,{title:'Future MCP note',tags:[],snapshot:value},'isolated MCP encoding test',async()=>{});assert.equal((await db.query('SELECT state_encoding FROM documents WHERE id=$1',[integrationId])).rows[0].state_encoding,2);
    // A legacy local cache contains an unsent body edit and only its original
    // identity history. The upgraded client adopts encoding2 before sending.
    const local=new Y.Doc();ydocs.push(local);Y.applyUpdate(local,bytes);const paragraph=local.getXmlFragment('default').get(0) as Y.XmlElement;(paragraph.get(0) as Y.XmlText).insert(0,'离线尚未同步 ');compactDocumentMigrationValues(local);
    const input={opId:randomUUID(),schema:EDITOR_SCHEMA_VERSION,ystate:Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64')};
    await assert.rejects(syncOffline(documents,owner,'a-small',input,1),(error:any)=>error.getStatus()===409);
    await assert.rejects(syncOffline(documents,peer,'a-small',input,2),(error:any)=>error.getStatus()===403);
    await syncOffline(documents,owner,'a-small',input,2);
    const merged=(await db.query("SELECT * FROM documents WHERE id='a-small'")).rows[0];assert.equal(merged.state_encoding,2);assert(stable(merged.snapshot).includes('离线尚未同步 原始正文保留'));
    const newId=randomUUID(),createInput={...input,opId:randomUUID(),create:{space_id:'book',title:'Future offline'},title:'Future offline'};
    await assert.rejects(syncOffline(documents,owner,newId,createInput,1),(error:any)=>error.getStatus()===409);await syncOffline(documents,owner,newId,createInput,2);assert.equal((await db.query('SELECT state_encoding FROM documents WHERE id=$1',[newId])).rows[0].state_encoding,2);
    const plainOfflineId=randomUUID();await syncOffline(documents,owner,plainOfflineId,{...createInput,opId:randomUUID(),ystate:bytes.toString('base64')},2);assert.equal((await db.query('SELECT state_encoding FROM documents WHERE id=$1',[plainOfflineId])).rows[0].state_encoding,2);
    // Both onboarding shells and their final documents must match the rollout.
    await db.query("UPDATE users SET is_admin=true WHERE id='owner'");
    await documents.create(owner,{space_id:'book',title:'ANote 功能与使用示例'});await documents.create(owner,{space_id:'book',title:'ChatGPT 连接与使用 ANote MCP'});
    const {ensureOnboarding}=await import('../../apps/api/dist/onboarding.js');await ensureOnboarding('peer');
    const guides=(await db.query("SELECT state_encoding,ystate FROM documents WHERE created_by='peer'")).rows;assert.equal(guides.length,2);
    for(const guide of guides){assert.equal(guide.state_encoding,2);const decoded=new Y.Doc();ydocs.push(decoded);Y.applyUpdate(decoded,guide.ystate);assert.equal(scanDocumentMigrationEncoding(decoded),2);}
    console.log(JSON.stringify({total:result.total,resumedConverted:result.converted,alreadyEncoded:result.alreadyEncoded,beforeBytes:preview.beforeBytes,afterBytes:preview.afterBytes,trashIncluded:true,legacyLocalEditMerged:true}));
  }finally{await connection?.disconnect();await documents?.close();await service?.release();for(const ydoc of ydocs)ydoc.destroy();fixture?.document.destroy();await database?.db.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});}
});

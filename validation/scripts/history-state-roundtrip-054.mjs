import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc,initProseMirrorDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {stable} from '@anote/sync-core';

const mode=process.argv[2],root='/evidence',note='roundtrip-note',owner='roundtrip-owner',book='roundtrip-book',password='ANote-054-History-Roundtrip!';
assert.equal(process.env.ANOTE_ISOLATED_TESTS,'1');
const read=async name=>JSON.parse(await fs.readFile(`${root}/${name}.json`,'utf8'));
const write=async(name,value)=>fs.writeFile(`${root}/${name}.json`,JSON.stringify(value,null,2)+'\n');
let database;
async function connect(){
  const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'db');assert.equal(url.username,'anote');assert.match(url.pathname,/^\/anote054_history_(source|restored)_\d+_\d+$/);
  database=await import('../../apps/api/dist/database.js');return database;
}
async function fingerprint(){
  const {db,digest}=database,{readHistoryVersionState}=await import('../../apps/api/dist/history-state-store.js');
  const current=(await db.query("SELECT state_encoding,encode(sha256(ystate),'hex') AS state_sha256,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') AS database_snapshot_sha256,to_jsonb(d)-'ystate'-'snapshot' AS metadata,snapshot FROM documents d WHERE id=$1",[note])).rows[0];
  assert.equal(current.state_encoding,1);
  const versions=[];
  for(const row of(await db.query("SELECT id,history_state_storage,ystate,snapshot,to_jsonb(v)-'ystate'-'snapshot' AS metadata FROM document_versions v WHERE doc_id=$1 ORDER BY id",[note])).rows){
    const bytes=await readHistoryVersionState(db,note,row.id);
    if(row.ystate)assert(row.ystate.equals(bytes),'retained legacy bytes differ from reconstruction');
    versions.push({id:row.id,format:row.history_state_storage,rawRetained:row.ystate!==null,retainedRawSha256:row.ystate?digest(row.ystate):null,retainedRawBytes:row.ystate?.length??null,rawSha256:digest(bytes),rawBytes:bytes.length,snapshotSha256:digest(stable(row.snapshot)),metadataSha256:digest(stable(row.metadata))});
  }
  const objects={};
  for(const [table,order]of[['document_history_chunks','sha256'],['document_history_manifests','sha256'],['document_history_manifest_chunks','manifest_sha256,ordinal']]){
    const rows=(await db.query(`SELECT to_jsonb(t)${table==='document_history_chunks'?"-'payload' || jsonb_build_object('payload_sha256',encode(sha256(payload),'hex'))":''} AS item FROM ${table} t WHERE doc_id=$1 ORDER BY ${order}`,[note])).rows.map(row=>row.item);
    objects[table]={count:rows.length,sha256:digest(stable(rows))};
  }
  return {stateEncoding:1,current:{rawSha256:current.state_sha256,snapshotSha256:digest(stable(current.snapshot)),metadataSha256:digest(stable(current.metadata))},versions,objects};
}
try{
  if(mode==='seed'){
    const {db,migrate,digest,transaction}=await connect();await migrate();
    const {passwordHash}=await import('../../apps/api/dist/auth.js'),{prepareHistoryState,writeHistoryVersion,migrateHistoryVersion}=await import('../../apps/api/dist/history-state-store.js');
    await db.query("INSERT INTO users(id,username,name,password_hash) VALUES($1,'roundtrip-owner','QA History Owner',$2)",[owner,await passwordHash(password)]);
    await db.query("INSERT INTO spaces(id,name,kind,created_by) VALUES($1,'QA Round Trip','personal',$2);",[book,owner]);
    await db.query("INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'admin')",[book,owner]);
    await db.query("INSERT INTO platform_settings(singleton,site_name,public_origin,auth_mode) VALUES(true,'QA History Round Trip',$1,'local')",[process.env.ANOTE_OLD_API_ORIGIN]);
    const document=prosemirrorJSONToYDoc(schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:'roundtrip-paragraph'},content:[{type:'text',text:'Synthetic generation 1'}]}]},'default'),generations=[];
    try{
      document.getMap('roundtrip-synthetic-only').set('stable-bytes',Uint8Array.from(randomBytes(512*1024)));
      for(let generation=1;generation<=3;generation++){
        if(generation>1){const text=document.getXmlFragment('default').get(0).get(0);text.delete(0,text.length);text.insert(0,`Synthetic generation ${generation}`);}
        const snapshot=initProseMirrorDoc(document.getXmlFragment('default'),schema).doc.toJSON(),ystate=Buffer.from(Y.encodeStateAsUpdate(document));generations.push({snapshot,ystate,prepared:await prepareHistoryState(ystate)});
      }
      const current=generations[2];await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate,tags) VALUES($1,$2,'QA Synthetic History',$3,$4,$5,ARRAY['synthetic','roundtrip'])",[note,book,owner,current.snapshot,current.ystate]);
      for(const [index,state]of generations.entries())await transaction(sql=>writeHistoryVersion(sql,{id:`v${index+1}-chunked`,docId:note,snapshot:state.snapshot,hash:digest(stable(state.snapshot)),state:state.prepared,author:owner,source:'checkpoint',editorIds:[owner],label:`Synthetic version ${index+1}`,versionName:`qa-${index+1}`,createdAt:new Date(`2026-11-01T00:00:0${index+1}Z`)}));
      for(const [id,index]of[['v0-legacy',0],['v-retained',1],['v-released',0]]){
        const value=generations[index];await db.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,editor_ids,label,version_name,created_at) VALUES($1,$2,$3,$4,$5,$6,'checkpoint',ARRAY[$6],$7,$8,'2026-11-01 00:00:00.123456+00')",[id,note,value.snapshot,value.ystate,digest(stable(value.snapshot)),owner,`Synthetic ${id}`,`qa-${id}`]);
      }
      await migrateHistoryVersion(note,'v-retained');process.env.ANOTE_HISTORY_ALLOW_LEGACY_RELEASE='1';await migrateHistoryVersion(note,'v-released',{releaseLegacy:true});delete process.env.ANOTE_HISTORY_ALLOW_LEGACY_RELEASE;
      const baseline=await fingerprint();assert.equal(baseline.versions.length,6);assert.equal(baseline.versions.filter(row=>row.format==='chunked-v1').length,5);assert.equal(baseline.versions.filter(row=>row.rawRetained).length,2);await write('baseline',baseline);
      console.log('Seeded 6 independent history versions using synthetic encoding-1 data.');
    }finally{document.destroy();}
  }else if(mode==='verify-restored'){
    await connect();const baseline=await read('baseline'),restored=await fingerprint();assert.deepEqual(restored,baseline);assert.equal((await database.db.query('SELECT count(*)::int AS n FROM documents WHERE state_encoding<>1')).rows[0].n,0,'refuse to start old backend against any encoding-2 note');await write('restored',{matched:true,oldBackendEncodingFencePassed:true,fingerprint:restored});console.log('PostgreSQL custom dump/restore matched every raw SHA, snapshot, metadata and object reference.');
  }else if(mode==='old-http'){
    const {db,digest}=await connect(),base=process.env.ANOTE_OLD_API_ORIGIN;assert.match(base,/^http:\/\/anote-054-old-api-\d+-\d+:3000$/);
    const deadline=Date.now()+60000;let healthy=false;
    while(Date.now()<deadline){try{healthy=(await fetch(base+'/api/health',{signal:AbortSignal.timeout(2000)})).ok;if(healthy)break;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}assert(healthy,'isolated old API did not become healthy');
    let token='';const request=async(path,body)=>{
      const response=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:base,...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)}),text=await response.text();
      assert(response.ok,`${path}: HTTP ${response.status} ${text.slice(0,300)}`);return JSON.parse(text);
    };
    token=(await request('/auth/login',{username:'roundtrip-owner',password})).token;assert(token);
    const baseline=await read('baseline'),list=await request('/documents');assert(list.some(row=>row.id===note));
    const detail=await request('/documents/'+note);assert.equal(digest(stable(detail.snapshot)),baseline.current.snapshotSha256);
    const versions=await request(`/documents/${note}/versions`);assert.equal(versions.filter(row=>baseline.versions.some(expected=>expected.id===row.id)).length,6);
    for(const expected of baseline.versions){const version=await request(`/documents/${note}/versions/${expected.id}`);assert.equal(digest(stable(version.snapshot)),expected.snapshotSha256);}
    const restored=await request(`/documents/${note}/versions/v1-chunked/restore`,{expectedHash:detail.hash});assert.equal(restored.ok,true);
    const current=await request('/documents/'+note),target=baseline.versions.find(row=>row.id==='v1-chunked');assert.equal(digest(stable(current.snapshot)),target.snapshotSha256);
    const checkpoint=await request(`/documents/${note}/versions`,{label:'QA old 0.5.3 writer',version_name:'qa-old-053'}),row=(await db.query('SELECT history_state_storage,history_state_manifest_sha256,ystate FROM document_versions WHERE id=$1',[checkpoint.id])).rows[0];assert.equal(row.history_state_storage,'legacy');assert.equal(row.history_state_manifest_sha256,null);assert(row.ystate.length>0);
    const created=await request('/documents',{space_id:book,title:'QA Old Writer Created Note'}),createdRow=(await db.query('SELECT history_state_storage,ystate FROM document_versions WHERE doc_id=$1',[created.id])).rows[0];assert.equal(createdRow.history_state_storage,'legacy');assert(createdRow.ystate.length>0);
    const after=await fingerprint();assert.deepEqual(after.versions.filter(row=>baseline.versions.some(expected=>expected.id===row.id)),baseline.versions);assert.deepEqual(after.objects,baseline.objects);assert.equal((await db.query('SELECT count(*)::int AS n FROM documents WHERE state_encoding<>1')).rows[0].n,0);
    await write('old-api',{passed:true,imageId:process.env.ANOTE_OLD_API_IMAGE_ID,encodingTested:1,documentsList:true,documentDetail:true,historyDetails:6,chunkedHistoryDetails:5,restoreChunkedSnapshot:true,oldCheckpointFormat:row.history_state_storage,oldCreateHistoryFormat:createdRow.history_state_storage,originalHistoriesPreserved:true,directEncoding2RollbackTested:false});console.log('Immutable old API read all history formats, restored a chunked snapshot and wrote legacy histories.');
  }else if(mode==='evidence'){
    const optional=async name=>{try{return await read(name);}catch{return null;}},baseline=await optional('baseline'),restored=await optional('restored'),oldApi=await optional('old-api');
    let dump=null;try{const [bytes,sha256]=(await fs.readFile(`${root}/dump.txt`,'utf8')).trim().split(' ');assert.match(sha256,/^[a-f0-9]{64}$/);dump={format:'PostgreSQL custom',bytes:Number(bytes),sha256};}catch{}
    const cleanup={oldApiContainerRemoved:process.env.ANOTE_CONTAINER_REMOVED==='1',sourceDatabaseRemoved:process.env.ANOTE_SOURCE_REMOVED==='1',restoredDatabaseRemoved:process.env.ANOTE_RESTORED_REMOVED==='1',temporaryDumpRemoved:process.env.ANOTE_DUMP_REMOVED==='1'};
    await fs.writeFile('/results/history-state-roundtrip-054.json',JSON.stringify({passed:process.env.ANOTE_RUN_EXIT==='0'&&!!restored?.matched&&!!oldApi?.passed&&Object.values(cleanup).every(Boolean),syntheticDataOnly:true,productionAccess:false,dump,baseline,restored,oldApi,cleanup,rollbackBoundary:'Only encoding-1 notes were exercised with 0.5.3. Encoding-2 notes require verified expansion before using an old collaboration backend.'},null,2)+'\n');
  }else throw new Error('Unknown isolated round-trip mode');
}finally{await database?.db.end();}

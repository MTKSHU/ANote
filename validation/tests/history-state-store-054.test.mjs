import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {stable} from '@anote/sync-core';

test('transactional historical states deduplicate, restore independently and protect legacy data',async t=>{
  assert.equal(process.env.ANOTE_ISOLATED_TESTS,'1','Run only on the isolated QA database network');
  const name='history_state_'+randomUUID().replaceAll('-',''),admin=new Pool({host:'db',user:'anote',database:'anote',password:process.env.DB_PASSWORD});let database,document;
  await admin.query(`CREATE DATABASE "${name}"`);
  try{
    const url=new URL('postgres://anote@db/'+name);url.password=process.env.DB_PASSWORD;process.env.DATABASE_URL=url.href;
    database=await import('../../apps/api/dist/database.js');await database.migrate();await import('../../apps/api/dist/teams.js');const {db,transaction,digest}=database;
    const store=await import('../../apps/api/dist/history-state-store.js');
    await db.query("INSERT INTO users(id,username,name,password_hash) VALUES('owner','owner','Owner','fixture'),('other','other','Other','fixture');INSERT INTO spaces(id,name,kind,created_by) VALUES('book','History','personal','owner')");
    const snapshot={type:'doc',content:[{type:'paragraph',attrs:{blockId:'paragraph'},content:[{type:'text',text:'原稿'}]}]};
    document=prosemirrorJSONToYDoc(schema,snapshot,'default');document.getMap('retained-synthetic-history').set('bytes','history-map-abcdef'.repeat(1050000));
    const initial=Buffer.from(Y.encodeStateAsUpdate(document));assert(initial.length>17*1024*1024);
    for(const id of ['note','other-note'])await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate) VALUES($1,'book',$1,'owner',$2,$3)",[id,snapshot,initial]);
    const prepared=await store.prepareHistoryState(initial),write=(id,state,value=snapshot,docId='note')=>transaction(sql=>store.writeHistoryVersion(sql,{id,docId,snapshot:value,hash:digest(stable(value)),state,source:'fixture',author:'owner',editorIds:['owner']}));
    const storage=async()=>{const row=(await db.query("SELECT count(*)::int AS chunks,coalesce(sum(raw_bytes),0)::bigint AS raw_bytes,coalesce(sum(octet_length(payload)),0)::bigint AS stored_bytes FROM document_history_chunks WHERE doc_id='note'")).rows[0];return {chunks:row.chunks,raw:Number(row.raw_bytes),stored:Number(row.stored_bytes)};};
    await t.test('same state is stored once and manifests reconstruct exact original bytes',async()=>{
      await write('first',prepared);const first=await storage();await write('identical',prepared);assert.deepEqual(await storage(),first);
      assert((await store.readHistoryVersionState(db,'note','first')).equals(initial));
      const row=(await db.query("SELECT ystate,history_state_storage FROM document_versions WHERE id='first'")).rows[0];assert.equal(row.ystate,null);assert.equal(row.history_state_storage,'chunked-v1');
    });
    let secondBytes,thirdBytes,second,third;
    await t.test('small edits to a large state add only changed content chunks',async()=>{
      document.getXmlFragment('default').get(0).get(0).insert(2,' 少量文字');secondBytes=Buffer.from(Y.encodeStateAsUpdate(document));second=await store.prepareHistoryState(secondBytes);const before=await storage();
      await write('middle',second);const after=await storage();assert(after.raw-before.raw<512*1024,`unexpected added raw chunks: ${after.raw-before.raw}`);assert(after.stored-before.stored<128*1024);
      document.getXmlFragment('default').get(0).get(0).insert(2,' 最新');thirdBytes=Buffer.from(Y.encodeStateAsUpdate(document));third=await store.prepareHistoryState(thirdBytes);await write('latest',third);
      assert((await store.readHistoryVersionState(db,'note','middle')).equals(secondBytes));assert((await store.readHistoryVersionState(db,'note','latest')).equals(thirdBytes));
    });
    await t.test('deleting a middle version cannot break independent earlier or later versions',async()=>{
      await db.query("DELETE FROM document_versions WHERE id='middle'");const result=await store.collectHistoryObjects('note');assert.equal(result.manifests,1);
      assert((await store.readHistoryVersionState(db,'note','first')).equals(initial));assert((await store.readHistoryVersionState(db,'note','latest')).equals(thirdBytes));
    });
    await t.test('raw objects remain document scoped and existing history authorization is preserved',async()=>{
      await assert.rejects(store.readHistoryVersionState(db,'other-note','first'),/不存在/);await assert.rejects(store.readHistoryManifest(db,'other-note',prepared.sha256),/缺失/);
      await write('other-version',prepared,snapshot,'other-note');assert((await store.readHistoryVersionState(db,'other-note','other-version')).equals(initial));
      const counts=(await db.query('SELECT doc_id,count(*)::int AS n FROM document_history_chunks GROUP BY doc_id')).rows;assert(counts.find(row=>row.doc_id==='other-note').n>0);
      const {Documents}=await import('../../apps/api/dist/documents.js'),documents=new Documents(),owner={id:'owner',name:'Owner',is_admin:false};
      assert.deepEqual((await documents.version(owner,'note','first')).snapshot,snapshot);
      await assert.rejects(documents.version({id:'other',is_admin:true},'note','first'),error=>error.status===403);
      const privateState=await store.prepareHistoryState(Buffer.from('bytes present only in another note'));
      await write('private-other-version',privateState,snapshot,'other-note');
      await assert.rejects(transaction(sql=>sql.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source,history_state_storage,history_state_manifest_sha256) VALUES('cross-note-reference','note',$1,NULL,'hash','fixture','chunked-v1',$2)",[snapshot,privateState.sha256])),error=>error.code==='23503');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM document_versions WHERE id='cross-note-reference'")).rows[0].n,0);
    });
    await t.test('corruption stops reconstruction, new commits and garbage collection without losing old rows',async()=>{
      const original=(await db.query("SELECT c.* FROM document_history_chunks c JOIN document_history_manifest_chunks r ON r.doc_id=c.doc_id AND r.chunk_sha256=c.sha256 WHERE r.doc_id='note' AND r.manifest_sha256=$1 ORDER BY r.ordinal LIMIT 1",[prepared.sha256])).rows[0],bad=Buffer.from(original.payload);bad[0]^=1;
      await db.query("UPDATE document_history_chunks SET payload=$3 WHERE doc_id=$1 AND sha256=$2",['note',original.sha256,bad]);
      await assert.rejects(store.readHistoryVersionState(db,'note','first'));
      await assert.rejects(store.collectHistoryObjects('note'));
      await assert.rejects(transaction(async sql=>{await sql.query("UPDATE documents SET title='must roll back' WHERE id='note'");await store.writeHistoryVersion(sql,{id:'bad-version',docId:'note',snapshot,hash:'fixture',state:prepared,source:'fixture'});}));
      assert.equal((await db.query("SELECT title FROM documents WHERE id='note'")).rows[0].title,'note');assert.equal((await db.query("SELECT count(*)::int AS n FROM document_versions WHERE id='bad-version'")).rows[0].n,0);
      await db.query('UPDATE document_history_chunks SET payload=$3 WHERE doc_id=$1 AND sha256=$2',['note',original.sha256,original.payload]);assert((await store.readHistoryVersionState(db,'note','first')).equals(initial));
    });
    await t.test('legacy conversion is verified and idempotent, retaining raw bytes until explicit release',async()=>{
      await db.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,label,version_name,editor_ids) VALUES('legacy','note',$1,$2,'legacy-hash','owner','checkpoint','说明','v-old',ARRAY['owner'])",[snapshot,initial]);
      const metadata=(await db.query("SELECT id,doc_id,snapshot,hash,author,source,label,version_name,editor_ids,created_at FROM document_versions WHERE id='legacy'")).rows[0];
      assert.equal((await store.migrateHistoryVersion('note','legacy')).status,'converted');let row=(await db.query("SELECT * FROM document_versions WHERE id='legacy'")).rows[0];assert(row.ystate.equals(initial));assert.equal(row.history_state_storage,'chunked-v1');
      assert.deepEqual((await db.query("SELECT id,doc_id,snapshot,hash,author,source,label,version_name,editor_ids,created_at FROM document_versions WHERE id='legacy'")).rows[0],metadata);
      const count=await storage();assert.equal((await store.migrateHistoryVersion('note','legacy')).status,'already-converted');assert.deepEqual(await storage(),count);
      delete process.env.ANOTE_HISTORY_ALLOW_LEGACY_RELEASE;await assert.rejects(store.migrateHistoryVersion('note','legacy',{releaseLegacy:true}),/尚未启用/);
      process.env.ANOTE_HISTORY_ALLOW_LEGACY_RELEASE='1';
      await db.query("UPDATE document_versions SET ystate=$1 WHERE id='legacy'",[thirdBytes]);
      await assert.rejects(store.migrateHistoryVersion('note','legacy',{releaseLegacy:true}),/不一致/);
      assert((await db.query("SELECT ystate FROM document_versions WHERE id='legacy'")).rows[0].ystate.equals(thirdBytes));
      await db.query("UPDATE document_versions SET ystate=$1 WHERE id='legacy'",[initial]);
      const reference=(await db.query("SELECT ordinal,raw_bytes FROM document_history_manifest_chunks WHERE doc_id='note' AND manifest_sha256=$1 ORDER BY ordinal LIMIT 1",[prepared.sha256])).rows[0];
      await db.query("UPDATE document_history_manifest_chunks SET raw_bytes=raw_bytes-1 WHERE doc_id='note' AND manifest_sha256=$1 AND ordinal=$2",[prepared.sha256,reference.ordinal]);
      await assert.rejects(store.readHistoryVersionState(db,'note','legacy'),/引用/);await assert.rejects(store.collectHistoryObjects('note'),/引用/);
      await assert.rejects(store.migrateHistoryVersion('note','legacy',{releaseLegacy:true}),/引用/);
      assert((await db.query("SELECT ystate FROM document_versions WHERE id='legacy'")).rows[0].ystate.equals(initial));
      await db.query("UPDATE document_history_manifest_chunks SET raw_bytes=$3 WHERE doc_id='note' AND manifest_sha256=$1 AND ordinal=$2",[prepared.sha256,reference.ordinal,reference.raw_bytes]);
      assert.equal((await store.migrateHistoryVersion('note','legacy',{releaseLegacy:true})).legacyReleased,true);delete process.env.ANOTE_HISTORY_ALLOW_LEGACY_RELEASE;
      row=(await db.query("SELECT * FROM document_versions WHERE id='legacy'")).rows[0];assert.equal(row.ystate,null);assert(row.history_state_legacy_released_at);assert((await store.readHistoryVersionState(db,'note','legacy')).equals(initial));
    });
    await t.test('cancellation has no version side effects and format constraints reject missing references',async()=>{
      const controller=new AbortController(),pending=store.prepareHistoryState(initial,controller.signal);controller.abort();await assert.rejects(pending,/中止|abort/i);
      await assert.rejects(db.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source,history_state_storage) VALUES('invalid','note',$1,NULL,'hash','fixture','chunked-v1')",[snapshot]));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM document_versions WHERE id='invalid'")).rows[0].n,0);
    });
    await t.test('empty archives round trip and old writers retain the legacy default',async()=>{
      await write('empty-archive',await store.prepareHistoryState(new Uint8Array()));assert.equal((await store.readHistoryVersionState(db,'note','empty-archive')).length,0);
      await db.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source) VALUES('old-writer','note',$1,$2,'old-hash','fixture')",[snapshot,initial]);
      const row=(await db.query("SELECT history_state_storage,history_state_manifest_sha256,ystate FROM document_versions WHERE id='old-writer'")).rows[0];
      assert.equal(row.history_state_storage,'legacy');assert.equal(row.history_state_manifest_sha256,null);assert(row.ystate.equals(initial));
    });
    await t.test('collector and a new version serialize safely under concurrent maintenance',async()=>{
      const results=await Promise.allSettled([write('concurrent',third),store.collectHistoryObjects('note')]);assert.equal(results[0].status,'fulfilled');if(results[1].status==='rejected')assert.match(results[1].reason.message,/引用正在变化/);
      await store.collectHistoryObjects('note');assert((await store.readHistoryVersionState(db,'note','concurrent')).equals(thirdBytes));
    });
    await t.test('permanent note deletion cascades history objects without touching another note',async()=>{
      await transaction(async sql=>{await sql.query("DELETE FROM document_versions WHERE doc_id='note'");await sql.query("DELETE FROM documents WHERE id='note'");});
      for(const table of ['document_history_chunks','document_history_manifests','document_history_manifest_chunks'])assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE doc_id='note'`)).rows[0].n,0);
      assert((await store.readHistoryVersionState(db,'other-note','other-version')).equals(initial));
    });
  }finally{document?.destroy();await database?.db.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});

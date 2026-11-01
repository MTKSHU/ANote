import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { schema } from '@anote/document-model';
import { stable } from '@anote/sync-core';

test('历史编辑者持久化、自动快照恢复及事务失败不产生虚假贡献记录', async () => {
  const name='history_'+randomUUID().replaceAll('-',''),admin=new Pool({host:'db',user:'anote',database:'anote',password:process.env.DB_PASSWORD});
  let db, document;
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    const url=new URL('postgres://anote@db/'+name);url.password=process.env.DB_PASSWORD;process.env.DATABASE_URL=url.href;
    const database=await import('../../apps/api/dist/database.js');db=database.db;await database.migrate();
    const {Documents}=await import('../../apps/api/dist/documents.js');
    await db.query("INSERT INTO users(id,username,name,password_hash) VALUES('a','a','协作甲','fixture'),('b','b','协作乙','fixture')");
    await db.query("INSERT INTO spaces(id,name,kind,created_by) VALUES('book','历史资料','personal','a')");
    const before={type:'doc',content:[{type:'paragraph',attrs:{blockId:'p'}}]},value={type:'doc',content:[{type:'paragraph',attrs:{blockId:'p'},content:[{type:'text',text:'保存在数据库的协作内容'}]}]};
    document=prosemirrorJSONToYDoc(schema,value,'default');
    await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate,pending_editor_ids) VALUES('note','book','持久化版本','a',$1,$2,ARRAY['a','b'])",[value,Buffer.from(Y.encodeStateAsUpdate(document))]);
    await db.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,created_at) VALUES('old','note',$1,$2,$3,'a','create',now()-interval '61 seconds')",[before,Buffer.from([0,0]),database.digest(stable(before))]);
    const account={id:'a',name:'协作甲',role:'editor',is_admin:false};
    const restarted=new Documents();await restarted.captureHistory();
    let versions=await restarted.versions(account,'note');
    assert.equal(versions.length,2);assert.equal(versions[0].source,'automatic');
    assert.deepEqual(versions[0].editors.map(editor=>editor.id).sort(),['a','b']);
    assert.deepEqual((await db.query("SELECT pending_editor_ids FROM documents WHERE id='note'")).rows[0].pending_editor_ids,[]);
    await new Documents().captureHistory();assert.equal((await restarted.versions(account,'note')).length,2);
    await db.query("UPDATE users SET name='甲方新昵称' WHERE id='a'");
    assert.ok((await restarted.version(account,'note',versions[0].id)).editors.some(editor=>editor.name==='甲方新昵称'));
    const old=await restarted.version(account,'note','old');assert.deepEqual(old.editors,[]);assert.equal(old.author_name,'甲方新昵称');
    const fragment=document.getXmlFragment('default');fragment.get(0).get(0).insert(0,'待回滚：');
    await assert.rejects(()=>restarted.persist('note',document,'a','markdown',true,async()=>{throw new Error('rollback-fixture');}),/rollback-fixture/);
    assert.deepEqual((await db.query("SELECT snapshot FROM documents WHERE id='note'")).rows[0].snapshot,value);
    assert.equal((await restarted.versions(account,'note')).length,2);
    assert.deepEqual((await db.query("SELECT pending_editor_ids FROM documents WHERE id='note'")).rows[0].pending_editor_ids,[]);
    // Saving another person's accepted, not-yet-stored live update isn't editing.
    restarted.editorUpdates.set('note',new Map([['b',1]]));
    const checkpoint=await restarted.persist('note',document,'a','checkpoint',true);
    assert.deepEqual((await restarted.version(account,'note',checkpoint.versionId)).editors.map(e=>e.id),['b']);
  } finally {
    document?.destroy();await db?.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
  }
});

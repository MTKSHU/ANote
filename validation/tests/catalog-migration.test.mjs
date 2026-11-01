import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
test("目录排序与历史编辑者迁移保留原文、权限、层级和旧版本，不补造协作人",async()=>{
  const name="catalog_"+randomUUID().replaceAll("-",""),config={host:"db",user:"anote",password:process.env.DB_PASSWORD},admin=new Pool({...config,database:"anote"});let db;
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    db=new Pool({...config,database:name});const files=(await fs.readdir("apps/api/migrations")).filter(f=>/^\d+_.*\.sql$/.test(f)).sort();
    for(const f of files.filter(f=>f<"015_"))await db.query(await fs.readFile("apps/api/migrations/"+f,"utf8"));
    await db.query("INSERT INTO users(id,username,name,password_hash) VALUES('owner','owner','作者','fixture')");
    await db.query("INSERT INTO teams(id,name,created_by) VALUES('team','团队','owner'); INSERT INTO team_members VALUES('team','owner','admin',now())");
    await db.query("INSERT INTO spaces(id,name,kind,team_id,created_by) VALUES('book','资料','team','team','owner'); INSERT INTO space_members(space_id,user_id,role) VALUES('book','owner','admin')");
    await db.query("INSERT INTO folders(id,space_id,parent_id,name,position) VALUES('f1','book',NULL,'一级',0),('f2','book','f1','二级',1)");
    await db.query("INSERT INTO documents(id,space_id,folder_id,title,created_by,ystate,snapshot) VALUES('d','book','f2','研究笔记','owner',$1,$2)",[Buffer.from([0,0]),{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"保留原稿"}]}]}]);
    await db.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source) SELECT 'v',id,snapshot,ystate,'original','collaboration' FROM documents; UPDATE teams SET announcement_doc_id='d'");
    const fingerprint=async()=> (await db.query("SELECT (SELECT json_agg(to_jsonb(d)-'pending_editor_ids' ORDER BY id) FROM documents d) AS documents,(SELECT json_agg(to_jsonb(v)-'editor_ids' ORDER BY id) FROM document_versions v) AS versions,(SELECT json_agg(f ORDER BY id) FROM folders f) AS folders,(SELECT json_agg(m ORDER BY space_id,user_id) FROM space_members m) AS grants")).rows[0];
    const before=await fingerprint();for(const f of files.filter(f=>f>="015_"))await db.query(await fs.readFile("apps/api/migrations/"+f,"utf8"));assert.deepEqual(await fingerprint(),before);
    assert.deepEqual((await db.query("SELECT editor_ids FROM document_versions WHERE id='v'")).rows[0].editor_ids,[]);
    const team=(await db.query("SELECT * FROM teams WHERE id='team'")).rows[0];assert.equal(team.announcement_doc_id,"d");assert.deepEqual(team.pinned_note_ids,[]);
    const book=(await db.query("SELECT catalog_order,catalog_revision FROM spaces WHERE id='book'")).rows[0];assert.deepEqual(book.catalog_order,["folder:f1","folder:f2","note:d"]);assert.equal(book.catalog_revision,"0");
    assert.equal((await db.query("SELECT theme FROM users WHERE id='owner'")).rows[0].theme,"light");await db.query("INSERT INTO users(id,username,name,password_hash) VALUES('new','new','新用户','fixture')");assert.equal((await db.query("SELECT theme FROM users WHERE id='new'")).rows[0].theme,"auto");
    await db.query("INSERT INTO folders(id,space_id,parent_id,name) VALUES('new-folder','book',NULL,'新目录')");assert.equal((await db.query("SELECT catalog_order FROM spaces WHERE id='book'")).rows[0].catalog_order.at(-1),"folder:new-folder");
    await db.query("UPDATE documents SET folder_id=NULL WHERE id='d'");assert.equal((await db.query("SELECT catalog_revision FROM spaces WHERE id='book'")).rows[0].catalog_revision,"2");
  }finally{await db?.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});

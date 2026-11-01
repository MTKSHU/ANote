import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

test('权限迁移只收紧团队默认授权，保留显式 ACL、作者身份、正文和回收站管理', async () => {
  const name = 'ownership_' + randomUUID().replaceAll('-', ''),
    config = { host: 'db', user: 'anote', password: process.env.DB_PASSWORD },
    admin = new Pool({ ...config, database: 'anote' });
  let db;
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    db = new Pool({ ...config, database: name });
    for (const file of (await fs.readdir('apps/api/migrations')).filter(n => /^\d+_.*\.sql$/.test(n) && n < '014_').sort())
      await db.query(await fs.readFile('apps/api/migrations/' + file, 'utf8'));
    await db.query("INSERT INTO users(id,username,name,password_hash,is_admin) SELECT id,id,id,'fixture',id='platform' FROM unnest(ARRAY['manager','librarian','author','peer','editor','viewer','platform']) AS id");
    await db.query("INSERT INTO teams(id,name,created_by) VALUES('team','权限团队','manager')");
    await db.query("INSERT INTO team_members(team_id,user_id,role) SELECT 'team',id,CASE WHEN id='manager' THEN 'admin' ELSE 'member' END FROM users WHERE id<>'platform'");
    await db.query("INSERT INTO spaces(id,name,created_by,kind,team_id,access_mode) VALUES('book','团队库','librarian','team','team','team')");
    await db.query("INSERT INTO space_members(space_id,user_id,role) VALUES('book','librarian','admin'),('book','editor','editor'),('book','viewer','viewer')");
    await db.query("INSERT INTO documents(id,space_id,title,created_by,ystate,snapshot,visibility) VALUES('public','book','公开笔记','author',$1,$2,'team'),('private','book','私有笔记','author',$1,$2,'private')", [Buffer.from([0,0]), { type:'doc', content:[{ type:'paragraph', content:[{ type:'text',text:'原始研究记录' }] }] }]);
    await db.query("INSERT INTO document_collaborators(doc_id,user_id,role) VALUES('private','peer','editor')");
    async function fingerprint() {
      return (await db.query("SELECT (SELECT json_agg(m ORDER BY space_id,user_id) FROM space_members m) AS libraries,(SELECT json_agg(c ORDER BY doc_id,user_id) FROM document_collaborators c) AS notes,(SELECT json_agg(json_build_array(id,created_by,snapshot,encode(ystate,'hex')) ORDER BY id) FROM documents) AS content")).rows[0];
    }
    async function role(actor, note='public') {
      return (await db.query('SELECT effective_document_role($1,$2) AS role', [actor,note])).rows[0].role;
    }
    assert.equal(await role('peer'), 'editor');
    const before = await fingerprint();
    await db.query('BEGIN');
    try { await db.query(await fs.readFile('apps/api/migrations/014_team_author_permissions.sql','utf8')); await db.query('COMMIT'); }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    assert.deepEqual(await fingerprint(), before);
    assert.equal((await db.query("SELECT effective_space_role('peer','book') AS role")).rows[0].role, 'contributor');
    for (const [actor, expected] of [['author','admin'],['peer','reviewer'],['editor','editor'],['viewer','viewer'],['librarian','admin'],['manager','admin'],['platform',null]])
      assert.equal(await role(actor), expected, actor);
    assert.equal(await role('peer','private'), 'editor');
    assert.equal(await role('editor','private'), null);
    assert.equal(Number((await db.query("SELECT access_revision FROM documents WHERE id='public'")).rows[0].access_revision), 2);
    await db.query("UPDATE documents SET deleted_at=now() WHERE id='public'");
    assert.equal(await role('author'), null);
    assert.equal((await db.query("SELECT effective_document_role_with_deleted('author','public') AS role")).rows[0].role,'admin');
    await db.query("DELETE FROM team_members WHERE user_id='author'");
    assert.equal((await db.query("SELECT effective_document_role_with_deleted('author','public') AS role")).rows[0].role,null);
  } finally {
    await db?.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
});

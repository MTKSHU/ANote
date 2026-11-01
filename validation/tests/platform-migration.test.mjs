import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import * as Y from "yjs";
test("legacy migration retains note/Yjs/version/comment IDs and private folder hierarchy", async () => {
  const name = "migration_" + randomUUID().replaceAll("-", ""),
    admin = new Pool({
      host: "db",
      user: "anote",
      database: "anote",
      password: process.env.DB_PASSWORD,
    });
  await admin.query(`CREATE DATABASE "${name}"`);
  let db;
  const directory = path.resolve(".work", name);
  try {
    const url = new URL("postgres://anote@db/" + name);
    url.password = process.env.DB_PASSWORD;
    process.env.DATABASE_URL = url.href;
    const module = await import("../../apps/api/dist/database.js");
    db = module.db;
    await fs.mkdir(directory, { recursive: true });
    for (const file of (await fs.readdir("apps/api/migrations")).filter((n) =>
      /^00[1-6]_/.test(n),
    ))
      await fs.copyFile("apps/api/migrations/" + file, directory + "/" + file);
    await module.migrate(directory);
    await db.query(
      "INSERT INTO users(id,username,name,password_hash,is_admin) VALUES('manager','manager','平台管理员','fixture',true),('researcher','researcher','研究员','fixture',false),('outsider','outsider','外部用户','fixture',false)",
    );
    await db.query(
      "INSERT INTO spaces(id,name,created_by,kind) VALUES('shared','研究库','manager','team'),('personal','个人库','outsider','personal')",
    );
    await db.query(
      "INSERT INTO space_members(space_id,user_id,role) VALUES('shared','manager','admin'),('shared','researcher','editor'),('personal','outsider','admin')",
    );
    await db.query(
      "INSERT INTO folders(id,space_id,parent_id,name) VALUES('root','shared',NULL,'项目'),('child','shared','root','实验')",
    );
    const value = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "fixture" },
            content: [{ type: "text", text: "私人实验笔记，保留正文。" }],
          },
        ],
      },
      document = new Y.Doc();
    document.getText("fixture").insert(0, "private note");
    const bytes = Buffer.from(Y.encodeStateAsUpdate(document));
    document.destroy();
    await db.query(
      "INSERT INTO documents(id,space_id,folder_id,title,created_by,ystate,snapshot,visibility) VALUES('private-note','shared','child','私人笔记','researcher',$1,$2,'private'),('team-note','shared',NULL,'团队笔记','researcher',$1,$2,'team')",
      [bytes, value],
    );
    const hash = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    await db.query(
      "INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source) VALUES('version','private-note',$1,$2,$3,'researcher','automatic')",
      [value, bytes, hash],
    );
    await db.query(
      "INSERT INTO comments(id,doc_id,author,body) VALUES('comment','private-note','researcher','保留评论')",
    );
    const before = (
      await db.query("SELECT id,snapshot,ystate FROM documents ORDER BY id")
    ).rows;
    await module.migrate();
    const after = (
      await db.query("SELECT id,snapshot,ystate FROM documents ORDER BY id")
    ).rows;
    assert.deepEqual(after, before);
    assert.equal(
      (await db.query("SELECT body FROM comments WHERE id='comment'")).rows[0]
        .body,
      "保留评论",
    );
    assert.equal(
      (
        await db.query(
          "SELECT id,hash FROM document_versions WHERE id='version'",
        )
      ).rows[0].hash,
      hash,
    );
    const note = (
      await db.query(
        "SELECT space_id,folder_id FROM documents WHERE id='private-note'",
      )
    ).rows[0];
    assert.equal(note.space_id, "personal-migrated-researcher");
    const names = [];
    let folder = note.folder_id;
    while (folder) {
      const row = (
        await db.query("SELECT name,parent_id FROM folders WHERE id=$1", [
          folder,
        ])
      ).rows[0];
      names.unshift(row.name);
      folder = row.parent_id;
    }
    assert.deepEqual(names, ["研究库", "项目", "实验"]);
    assert.equal(
      (
        await db.query(
          "SELECT effective_document_role('manager','private-note') AS role",
        )
      ).rows[0].role,
      null,
    );
    assert.equal(
      (
        await db.query(
          "SELECT effective_document_role('researcher','private-note') AS role",
        )
      ).rows[0].role,
      "admin",
    );
    assert.equal(
      (
        await db.query(
          "SELECT effective_document_role('researcher','team-note') AS role",
        )
      ).rows[0].role,
      "admin",
    );
    assert.equal(
      (
        await db.query(
          "SELECT effective_document_role('outsider','team-note') AS role",
        )
      ).rows[0].role,
      null,
    );
    const beforeMigrationCount = (
      await db.query("SELECT count(*) FROM schema_migrations")
    ).rows[0].count;
    await module.migrate();
    assert.equal(
      (await db.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
      beforeMigrationCount,
    );
  } finally {
    await db?.end();
    // pg Pool.end can resolve before PostgreSQL observes the last socket closing.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        !(
          await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [
            name,
          ])
        ).rowCount
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

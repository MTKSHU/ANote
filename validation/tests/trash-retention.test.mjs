import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
test("permanent deletion, 30-day retention and shared-resource cleanup preserve live data", async (t) => {
  const name = "trash_" + randomUUID().replaceAll("-", ""),
    directory = path.resolve(".work", name);
  const admin = new Pool({
    host: "db",
    user: "anote",
    database: "anote",
    password: process.env.DB_PASSWORD,
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  let db, documents;
  try {
    const url = new URL("postgres://anote@db/" + name);
    url.password = process.env.DB_PASSWORD;
    process.env.DATABASE_URL = url.href;
    process.env.ASSET_ROOT = directory;
    const database = await import("../../apps/api/dist/database.js");
    db = database.db;
    await database.migrate();
    const { purgeTrash, expireTrash, collectStorage } = await import(
      "../../apps/api/dist/trash-maintenance.js"
    );
    const { initializeStorage, storagePath } = await import(
      "../../apps/api/dist/storage.js"
    );
    await initializeStorage();
    await db.query(
      "INSERT INTO users(id,username,name,password_hash,is_admin) VALUES('owner','owner','Owner','fixture',false),('other','other','Other','fixture',true)",
    );
    const owner = { id: "owner", is_admin: false },
      other = { id: "other", is_admin: true };
    const book = async (id, kind = "personal", team = null) => {
      await db.query(
        "INSERT INTO spaces(id,name,created_by,kind,team_id) VALUES($1,$1,'owner',$2,$3)",
        [id, kind, team],
      );
      await db.query(
        "INSERT INTO space_members(space_id,user_id,role) VALUES($1,'owner','admin')",
        [id],
      );
    };
    const note = async (id, space, age = null) => {
      await db.query(
        "INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate,deleted_at,trash_batch) VALUES($1,$2,$1,'owner',$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE now()-make_interval(days=>$5) END,$6)",
        [
          id,
          space,
          {
            type: "doc",
            content: [
              {
                type: "paragraph",
                attrs: { blockId: id + "-p" },
                content: [{ type: "text", text: "preserved " + id }],
              },
            ],
          },
          Buffer.from([0, 0]),
          age,
          age === null ? null : id + "-token",
        ],
      );
    };
    await t.test(
      "administrator has no implicit private access; restored and stale deletions are rejected",
      async () => {
        await book("private");
        await note("private-note", "private", 1);
        await assert.rejects(
          purgeTrash("documents", "private-note", {
            account: other,
            token: "private-note-token",
          }),
          (error) => error.status === 403,
        );
        await assert.rejects(
          purgeTrash("documents", "private-note", {
            account: owner,
            token: "stale",
          }),
          (error) => error.status === 409,
        );
        await db.query(
          "UPDATE documents SET deleted_at=NULL,trash_batch=NULL WHERE id='private-note'",
        );
        await assert.rejects(
          purgeTrash("documents", "private-note", {
            account: owner,
            token: "private-note-token",
          }),
          (error) => error.status === 409,
        );
        assert.equal(
          (
            await db.query(
              "SELECT snapshot->'content'->0->'content'->0->>'text' AS text FROM documents WHERE id='private-note'",
            )
          ).rows[0].text,
          "preserved private-note",
        );
      },
    );
    await t.test(
      "expired rows clear, fresh trash and old live notes stay",
      async () => {
        await note("expired", "private", 31);
        await note("fresh", "private", 29);
        await note("live", "private");
        await db.query(
          "UPDATE documents SET created_at=now()-interval '100 days' WHERE id='live'",
        );
        await expireTrash();
        assert.equal(
          (await db.query("SELECT 1 FROM documents WHERE id='expired'"))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await db.query(
              "SELECT 1 FROM documents WHERE id IN('fresh','live','private-note')",
            )
          ).rowCount,
          3,
        );
        assert.equal(
          (
            await db.query(
              "SELECT 1 FROM audit_events WHERE action='trash.expire' AND target='expired'",
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "complete team subtree, comment replies, versions and legacy records clear together",
      async () => {
        await db.query(
          "INSERT INTO teams(id,name,created_by,deleted_at,trash_batch) VALUES('gone-team','Gone','owner',now()-interval '31 days','team-token')",
        );
        await db.query(
          "INSERT INTO team_members VALUES('gone-team','owner','admin',now())",
        );
        await book("gone-book", "team", "gone-team");
        await db.query(
          "UPDATE spaces SET deleted_at=now()-interval '31 days',trash_batch='team-token' WHERE id='gone-book'",
        );
        await note("gone-note", "gone-book", 31);
        await db.query(
          "UPDATE documents SET trash_batch='team-token' WHERE id='gone-note'",
        );
        await db.query(
          "INSERT INTO folders(id,space_id,name) VALUES('root-folder','gone-book','root')",
        );
        await db.query(
          "INSERT INTO folders(id,space_id,parent_id,name) VALUES('child-folder','gone-book','root-folder','child')",
        );
        await db.query(
          "UPDATE documents SET folder_id='child-folder' WHERE id='gone-note'",
        );
        await db.query(
          "INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source) VALUES('version','gone-note','{}','\\x','fixture','test')",
        );
        await db.query(
          "INSERT INTO comments(id,doc_id,author,body) VALUES('comment','gone-note','owner','text')",
        );
        await db.query(
          "INSERT INTO comments(id,doc_id,parent_id,author,body) VALUES('reply','gone-note','comment','owner','reply')",
        );
        await db.query(
          "INSERT INTO experiments(id,space_id,title,created_by,document_id) VALUES('experiment','gone-book','test','owner','gone-note')",
        );
        await db.query(
          "UPDATE teams SET announcement_doc_id='gone-note' WHERE id='gone-team'",
        );
        await expireTrash();
        for (const [table, id] of [
          ["teams", "gone-team"],
          ["spaces", "gone-book"],
          ["documents", "gone-note"],
          ["comments", "reply"],
          ["folders", "child-folder"],
          ["document_versions", "version"],
          ["experiments", "experiment"],
        ])
          assert.equal(
            (await db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]))
              .rowCount,
            0,
            table,
          );
        assert.equal(
          (await db.query("SELECT 1 FROM documents WHERE id='live'")).rowCount,
          1,
        );
      },
    );
    await t.test(
      "cloned attachments keep their shared original until the final reference is deleted",
      async () => {
        await note("source", "private", 1);
        await note("copy", "private");
        for (const [id, doc] of [
          ["asset-source", "source"],
          ["asset-copy", "copy"],
        ]) {
          await db.query(
            "INSERT INTO assets(id,space_id,created_by,filename,mime,bytes,hash,storage_key,kind,owner_doc_id) VALUES($1,'private','owner','test.bin','application/octet-stream',5,'fixture','shared.bin','file',$2)",
            [id, doc],
          );
          await db.query("INSERT INTO document_assets VALUES($1,$2)", [
            doc,
            id,
          ]);
        }
        await fs.writeFile(storagePath("originals", "shared.bin"), "bytes");
        await purgeTrash("documents", "source", {
          account: owner,
          token: "source-token",
        });
        await collectStorage();
        assert.equal(
          await fs.readFile(storagePath("originals", "shared.bin"), "utf8"),
          "bytes",
        );
        await db.query(
          "UPDATE documents SET deleted_at=now(),trash_batch='copy-token' WHERE id='copy'",
        );
        await purgeTrash("documents", "copy", {
          account: owner,
          token: "copy-token",
        });
        await collectStorage();
        await assert.rejects(fs.access(storagePath("originals", "shared.bin")));
      },
    );
    await t.test(
      "legacy attachments referenced by another library survive library deletion and remain private",
      async () => {
        await book("source-library");
        await book("survivor-library");
        await note("source-legacy", "source-library", 1);
        await note("survivor", "survivor-library");
        await db.query(
          "UPDATE spaces SET deleted_at=now(),trash_batch='source-library-token' WHERE id='source-library'",
        );
        await db.query(
          "INSERT INTO assets(id,space_id,created_by,filename,mime,bytes,hash,storage_key,kind) VALUES('legacy','source-library','owner','legacy.bin','application/octet-stream',6,'fixture','legacy.bin','file')",
        );
        await db.query(
          "INSERT INTO document_assets VALUES('source-legacy','legacy'),('survivor','legacy')",
        );
        await fs.writeFile(storagePath("originals", "legacy.bin"), "legacy");
        const result = await purgeTrash("spaces", "source-library", {
          account: owner,
          token: "source-library-token",
        });
        await collectStorage();
        assert.equal(result.preservedAssets, 1);
        const asset = (
          await db.query(
            "SELECT space_id,owner_doc_id FROM assets WHERE id='legacy'",
          )
        ).rows[0];
        assert.equal(asset.space_id, null);
        assert.equal(asset.owner_doc_id, null);
        assert.equal(
          (
            await db.query(
              "SELECT effective_document_role('owner','survivor') AS role",
            )
          ).rows[0].role,
          "admin",
        );
        assert.equal(
          (
            await db.query(
              "SELECT effective_document_role('other','survivor') AS role",
            )
          ).rows[0].role,
          null,
        );
        assert.equal(
          await fs.readFile(storagePath("originals", "legacy.bin"), "utf8"),
          "legacy",
        );
        const Y = await import("yjs"),
          { schema } = await import("@anote/document-model"),
          { prosemirrorJSONToYDoc } = await import("@tiptap/y-tiptap");
        const content = {
          type: "doc",
          content: [
            {
              type: "mediaResource",
              attrs: {
                blockId: "legacy-media",
                assetId: "legacy",
                localPath: "assets/legacy.bin",
                src: "/api/assets/legacy/file",
                title: "legacy.bin",
                kind: "file",
                mime: "application/octet-stream",
                bytes: 6,
                hash: "fixture",
              },
            },
          ],
        };
        const ydoc = prosemirrorJSONToYDoc(schema, content, "default");
        await db.query(
          "UPDATE documents SET snapshot=$1,ystate=$2 WHERE id='survivor'",
          [content, Buffer.from(Y.encodeStateAsUpdate(ydoc))],
        );
        ydoc.destroy();
        const { Documents } = await import("../../apps/api/dist/documents.js");
        process.env.PORT = "0";
        documents = new Documents();
        await documents.start((_req, res) => res.end());
        const exported = await documents.export(owner, "survivor");
        assert.equal(exported.assets[0].id, "legacy");
        const { assetFor } = await import("../../apps/api/dist/assets.js");
        assert.equal((await assetFor(owner, "legacy")).id, "legacy");
        await assert.rejects(assetFor(other, "legacy"), (error) =>
          [403, 404].includes(error.status),
        );
        await db.query(
          "UPDATE spaces SET deleted_at=now(),trash_batch='survivor-library-token' WHERE id='survivor-library'",
        );
        await db.query(
          "UPDATE documents SET deleted_at=now(),trash_batch='survivor-library-token' WHERE id='survivor'",
        );
        await purgeTrash("spaces", "survivor-library", {
          account: owner,
          token: "survivor-library-token",
        });
        await collectStorage();
        await assert.rejects(fs.access(storagePath("originals", "legacy.bin")));
      },
    );
    await t.test(
      "auto purge waits if a descendant has not reached its own 30-day deadline",
      async () => {
        await book("mixed");
        await db.query(
          "UPDATE spaces SET deleted_at=now()-interval '31 days',trash_batch='mixed-token' WHERE id='mixed'",
        );
        await note("mixed-younger", "mixed", 29);
        await expireTrash();
        assert.equal(
          (await db.query("SELECT 1 FROM spaces WHERE id='mixed'")).rowCount,
          1,
        );
        assert.equal(
          (await db.query("SELECT 1 FROM documents WHERE id='mixed-younger'"))
            .rowCount,
          1,
        );
      },
    );
    await t.test(
      "legacy record attachments keep scoped access and clear after the final record library is removed",
      async () => {
        await book("record-source");
        await book("record-survivor");
        await db.query(
          "UPDATE spaces SET deleted_at=now(),trash_batch='record-source-token' WHERE id='record-source'",
        );
        await db.query(
          "INSERT INTO assets(id,space_id,created_by,filename,mime,bytes,hash,storage_key,kind) VALUES('record-asset','record-source','owner','record.bin','application/octet-stream',6,'fixture','record.bin','file')",
        );
        await fs.writeFile(storagePath("originals", "record.bin"), "record");
        await db.query(
          "INSERT INTO experiments(id,space_id,title,created_by,asset_ids) VALUES('surviving-experiment','record-survivor','record','owner',ARRAY['record-asset'])",
        );
        await purgeTrash("spaces", "record-source", {
          account: owner,
          token: "record-source-token",
        });
        await collectStorage();
        const { assetFor } = await import("../../apps/api/dist/assets.js");
        assert.equal(
          (await assetFor(owner, "record-asset")).id,
          "record-asset",
        );
        await assert.rejects(assetFor(other, "record-asset"), (error) =>
          [403, 404].includes(error.status),
        );
        await db.query(
          "UPDATE spaces SET deleted_at=now(),trash_batch='record-survivor-token' WHERE id='record-survivor'",
        );
        await purgeTrash("spaces", "record-survivor", {
          account: owner,
          token: "record-survivor-token",
        });
        await collectStorage();
        await assert.rejects(fs.access(storagePath("originals", "record.bin")));
      },
    );
  } finally {
    await documents?.close();
    await db?.end();
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

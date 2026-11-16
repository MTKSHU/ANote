import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { migrateStorageTree, assertStorageDirectory, assertPersonalDirectory } from "../../apps/desktop/main/storage-migration.mjs";
import { SessionStore } from "../../apps/desktop/main/session-store.mjs";

async function temporary(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anote-migrate-"));
  try { await work(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function seed(root) {
  const source = path.join(root, "old", ".anote"), destination = path.join(root, "new", ".anote");
  await fs.mkdir(path.join(source, "assets"), { recursive: true });
  await fs.mkdir(path.dirname(destination));
  await fs.writeFile(path.join(source, "assets", "image.bin"), Buffer.from([0, 255, 10, 128]));
  await fs.writeFile(path.join(source, "catalog.json"), '{"id":"unchanged-library"}');
  await fs.writeFile(path.join(source, "lock.json"), "active-source-lock");
  return { source, destination };
}

test("verified cross-directory migration preserves binary attachments, library identity and the recovery copy", () => temporary(async root => {
  const { source, destination } = await seed(root);
  let active = source;
  await migrateStorageTree({ source, destination, skip: ["lock.json"], commit: async target => { active = target; } });
  assert.equal(active, destination);
  assert.deepEqual(await fs.readFile(path.join(destination, "assets", "image.bin")), await fs.readFile(path.join(source, "assets", "image.bin")));
  assert.equal(await fs.readFile(path.join(destination, "catalog.json"), "utf8"), '{"id":"unchanged-library"}');
  await assert.rejects(fs.stat(path.join(destination, "lock.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(source, "lock.json"), "utf8"), "active-source-lock");
  assert.deepEqual(await fs.readdir(path.dirname(destination)), [".anote"]);
}));

test("existing destination data is never merged or overwritten", () => temporary(async root => {
  const { source, destination } = await seed(root);
  await fs.mkdir(destination); await fs.writeFile(path.join(destination, "other-note"), "other account");
  let committed = false;
  await assert.rejects(migrateStorageTree({ source, destination, commit: async () => { committed = true; } }), /目标已有/);
  assert.equal(committed, false);
  assert.equal(await fs.readFile(path.join(destination, "other-note"), "utf8"), "other account");
  assert.equal(await fs.readFile(path.join(source, "catalog.json"), "utf8"), '{"id":"unchanged-library"}');
}));

test("interrupted copy and failed pointer commit leave the source active and remove only this migration's partial copy", () => temporary(async root => {
  const { source, destination } = await seed(root);
  for (const options of [
    { afterCopy: async () => { throw new Error("copy interrupted"); }, commit: async () => assert.fail("commit must not run") },
    { commit: async () => { throw new Error("pointer unavailable"); } },
  ]) {
    await assert.rejects(migrateStorageTree({ source, destination, ...options }), /interrupted|unavailable/);
    assert.equal(await fs.readFile(path.join(source, "catalog.json"), "utf8"), '{"id":"unchanged-library"}');
    assert.deepEqual(await fs.readdir(path.dirname(destination)), []);
  }
}));

test("symbolic links and recursive target directories are rejected before switching the pointer", () => temporary(async root => {
  const { source, destination } = await seed(root);
  await fs.symlink(path.join(root, "outside"), path.join(source, "assets", "linked"));
  await assert.rejects(migrateStorageTree({ source, destination, commit: async () => assert.fail("must not commit") }), /符号链接/);
  await fs.unlink(path.join(source, "assets", "linked"));
  await assert.rejects(migrateStorageTree({ source, destination: path.join(source, "nested"), commit: async () => assert.fail("must not commit") }), /互相包含/);
  await assert.rejects(migrateStorageTree({ source, destination: source, commit: async () => assert.fail("must not commit") }), /互相包含/);
}));

test("server data directory survives a restart and switching accounts restores each account's own directory", () => temporary(async root => {
  const session = await new SessionStore(path.join(root, "profile"), { isAsyncEncryptionAvailable: async () => false }).load();
  const token = "B".repeat(43), user = { id: "account-one" };
  await session.acceptSession("https://one.example", { token, user });
  await fs.mkdir(path.join(session.dataRoot, "offline", "documents"), { recursive: true });
  await fs.writeFile(path.join(session.dataRoot, "offline", "documents", "pending.json"), '{"pending":{"opId":"must-survive"}}');
  const source = session.dataRoot, destination = path.join(root, "external-server-data");
  await migrateStorageTree({ source, destination, commit: async target => { session.settings.dataDirectory = target; await session.save(); } });
  const restarted = await new SessionStore(session.root, { isAsyncEncryptionAvailable: async () => false }).load();
  assert.equal(restarted.dataRoot, destination);
  assert.equal(await fs.readFile(path.join(destination, "offline", "documents", "pending.json"), "utf8"), '{"pending":{"opId":"must-survive"}}');
  await restarted.acceptSession("https://two.example", { token, user });
  assert.notEqual(restarted.dataRoot, destination);
  await restarted.acceptSession("https://one.example", { token, user });
  assert.equal(restarted.dataRoot, destination);
}));

test("previous managed Markdown notes and their attachments move together without losing synchronization baselines", () => temporary(async root => {
  const { source, destination } = await seed(root), legacy = path.join(root, "legacy-note");
  await fs.mkdir(path.join(legacy, ".anote"), { recursive: true });
  await fs.writeFile(path.join(legacy, ".anote", "note.base.json"), '{"revision":"stable"}');
  await fs.writeFile(path.join(legacy, "note.md"), "unsynchronized edit");
  await migrateStorageTree({ source, destination, extraSources: [{ source: legacy, relative: "managed-markdown/note" }], commit: async () => {} });
  assert.equal(await fs.readFile(path.join(destination, "managed-markdown", "note", ".anote", "note.base.json"), "utf8"), '{"revision":"stable"}');
  assert.equal(await fs.readFile(path.join(destination, "managed-markdown", "note", "note.md"), "utf8"), "unsynchronized edit");
}));

test("an unavailable external work directory stays missing rather than becoming an empty notebook", () => temporary(async root => {
  const dataRoot = path.join(root, "unmounted-volume", "anote");
  await assert.rejects(assertStorageDirectory({dataRoot,settings:{dataDirectory:dataRoot}}), /重新连接磁盘/);
  await assert.rejects(fs.stat(path.dirname(dataRoot)), {code:"ENOENT"});
}));

test("external data requires the matching account marker before starting synchronization", () => temporary(async root => {
  const dataRoot = path.join(root, "external"); await fs.mkdir(dataRoot);
  const session = {dataRoot,profileKey:"account-key",settings:{dataDirectory:dataRoot,serverURL:"https://one.example",user:{id:"one"}}};
  await assert.rejects(assertStorageDirectory(session), /标记缺失/);
  await fs.writeFile(path.join(dataRoot,".anote-storage.json"),JSON.stringify({profileKey:"other",serverURL:"https://one.example",userId:"one"}));
  await assert.rejects(assertStorageDirectory(session), /不属于当前账号/);
  await fs.writeFile(path.join(dataRoot,".anote-storage.json"),JSON.stringify({profileKey:"account-key",serverURL:"https://one.example",userId:"one"}));
  await assertStorageDirectory(session);
  await fs.rename(dataRoot,dataRoot+"-disconnected");
  await assert.rejects(assertStorageDirectory(session), /重新连接磁盘/);
  await assert.rejects(fs.stat(dataRoot), {code:"ENOENT"});
}));

test("restoring a personal work directory never initializes an empty mount point or follows a linked catalog", () => temporary(async root => {
  await assert.rejects(assertPersonalDirectory(root), /未创建空笔记库/);
  assert.deepEqual(await fs.readdir(root), []);
  const managed = path.join(root,".anote"); await fs.mkdir(managed);
  await assert.rejects(assertPersonalDirectory(root), /未创建空笔记库/);
  assert.deepEqual(await fs.readdir(managed), []);
  const catalog = {format:"simple-notes-personal",version:1,id:"12345678-1234-1234-1234-123456789012"};
  await fs.writeFile(path.join(managed,"catalog.json"),JSON.stringify(catalog));
  await assertPersonalDirectory(root);
  await fs.rename(managed,path.join(root,".simple-notes"));
  await assertPersonalDirectory(root);
  await fs.rename(path.join(root,".simple-notes","catalog.json"),path.join(root,"outside.json"));
  await fs.symlink(path.join(root,"outside.json"),path.join(root,".simple-notes","catalog.json"));
  await assert.rejects(assertPersonalDirectory(root), /清单无效/);
}));

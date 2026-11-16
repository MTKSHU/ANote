import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import * as Y from "yjs";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {BackupRepository} from "../../apps/desktop/main/incremental-backups.mjs";
import {runBackupWorker} from "../../apps/desktop/main/backup-worker-runner.mjs";
import {OfflineStore} from "../../apps/desktop/main/offline-store.mjs";

const identity={serverURL:"https://worker.example.test",userId:"worker-owner"};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"anote-backup-worker-")),sourceRoot=path.join(root,"offline"),backupRoot=path.join(root,"backups");
  await fs.mkdir(path.join(sourceRoot,"documents"),{recursive:true});await fs.mkdir(backupRoot);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const data={format:2,identity,libraries:[],availableLibraries:[],folders:{},catalogs:{},config:{retention:10},documents:["note"]};
  const record={metadata:{id:"note",title:"worker source",role:"admin"},ystate:"AQ==",snapshot:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"persisted source"}]}]},assets:[]};
  await fs.writeFile(path.join(sourceRoot,"index.json"),JSON.stringify(data));await fs.writeFile(path.join(sourceRoot,"documents/note.json"),JSON.stringify(record));
  const job={operation:"capture",sourceRoot,backupRoot,identity,schema:EDITOR_SCHEMA_VERSION,retention:10};
  return {root,sourceRoot,backupRoot,job,data,record};
}

test("capture reads persisted records in a real worker and keeps the parent event loop responsive",async t=>{
  const f=await fixture(t),text="large independent backup content ".repeat(90000);
  f.record.snapshot.content[0].content[0].text=text;
  await fs.writeFile(path.join(f.sourceRoot,"documents/note.json"),JSON.stringify(f.record));
  let ticks=0,maxGap=0,previous=performance.now();const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;},5);
  let value;try{value=await runBackupWorker(f.job);}finally{clearInterval(timer);}
  assert.ok(value.threadId>0);assert.ok(ticks>=3,"parent timers must run during background capture");
  assert.ok(maxGap<300,`parent event loop stalled for ${maxGap} ms`);
  const repository=new BackupRepository(f.backupRoot,{identity,schema:EDITOR_SCHEMA_VERSION}),saved=await repository.read(value.result.id);
  assert.equal(saved.data.documents.note.snapshot.content[0].content[0].text,text);assert.equal(value.backups.length,1);
  const unchanged=await runBackupWorker(f.job);assert.equal(unchanged.result.skipped,true);assert.equal(unchanged.result.addedBytes,0);
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot,"locks")),[]);
});

test("a crashed worker removes only its unique claim and keeps existing backups intact",async t=>{
  const f=await fixture(t),first=await runBackupWorker(f.job),locks=path.join(f.backupRoot,"locks"),foreign=`0123456789abcdef-1-${randomUUID()}.lock`;
  await fs.writeFile(path.join(locks,foreign),"foreign owner");
  const script=path.join(f.root,"crashed-worker.mjs"),module=new URL("../../apps/desktop/main/incremental-backups.mjs",import.meta.url).href;
  await fs.writeFile(script,`import fs from 'node:fs/promises';import path from 'node:path';import {workerData} from 'node:worker_threads';import {backupWorkerClaimName} from ${JSON.stringify(module)};await fs.writeFile(path.join(workerData.backupRoot,'locks',backupWorkerClaimName(workerData.claimId)),'own claim');process.exit(7);`);
  await assert.rejects(runBackupWorker(f.job,script),/意外退出（7）/);
  assert.deepEqual(await fs.readdir(locks),[foreign]);assert.equal((await new BackupRepository(f.backupRoot,{identity,schema:EDITOR_SCHEMA_VERSION}).manifests())[0].id,first.result.id);
  await fs.unlink(path.join(locks,foreign));assert.equal((await runBackupWorker(f.job)).result.skipped,true);
});

test("worker rejects another account's disk index without replacing a retained backup",async t=>{
  const f=await fixture(t),first=await runBackupWorker(f.job);
  await fs.writeFile(path.join(f.sourceRoot,"index.json"),JSON.stringify({...f.data,identity:{...identity,userId:"another-account"}}));
  await assert.rejects(runBackupWorker(f.job),/不属于当前账号/);
  const list=await runBackupWorker({...f.job,operation:"list"});assert.deepEqual(list.backups.map(item=>item.id),[first.result.id]);
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot,"locks")),[]);
});

test("worker deletion is serialized and preserves the other retained time point",async t=>{
  const f=await fixture(t),first=await runBackupWorker(f.job);f.record.metadata.title="changed title";
  await fs.writeFile(path.join(f.sourceRoot,"documents/note.json"),JSON.stringify(f.record));const next=await runBackupWorker(f.job);
  const removed=await runBackupWorker({...f.job,operation:"remove",version:first.result.id});assert.deepEqual(removed.backups.map(item=>item.id),[next.result.id]);
  assert.equal((await new BackupRepository(f.backupRoot,{identity,schema:EDITOR_SCHEMA_VERSION}).read(next.result.id)).data.documents.note.metadata.title,"changed title");
});

test("OfflineStore close waits for worker capture and a queued newer local edit",async t=>{
  const f=await fixture(t),session={profileRoot:path.join(f.root,"profile"),settings:{serverURL:identity.serverURL,user:{id:identity.userId},offline:true},token:null};
  const store=await new OfflineStore(session).load();t.after(()=>store.close());store.data.config.backupDirectory=f.backupRoot;
  const doc=prosemirrorJSONToYDoc(schema,{type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text:"before backup"}]}]},"default");
  const original=Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");await store.cacheDocument({id:"note",ystate:original,metadata:{id:"note",title:"serial backup",role:"admin"}});
  const backing=store.backup();doc.getXmlFragment("default").get(0).get(0).insert("before backup".length," · newest edit");
  const editing=store.cacheDocument({id:"note",ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")});doc.destroy();
  const closing=store.close(),backup=await backing;await Promise.all([editing,closing]);
  const saved=await new BackupRepository(await store.backupRoot(),{identity,schema:EDITOR_SCHEMA_VERSION}).read(backup.id);
  assert.equal(saved.data.documents.note.snapshot.content[0].content[0].text,"before backup");
  const current=JSON.parse(await fs.readFile(path.join(store.root,"documents/note.json"),"utf8"));assert.equal(current.snapshot.content[0].content[0].text,"before backup · newest edit");assert.equal(store.closed,true);
});

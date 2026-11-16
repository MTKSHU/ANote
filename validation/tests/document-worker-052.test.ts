import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import * as Y from "yjs";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import {schema} from "@anote/document-model";
import {runDocumentWorker} from "../../apps/desktop/main/document-worker-runner.mjs";
import {OfflineStore} from "../../apps/desktop/main/offline-store.mjs";
import {historyHeavyTodo052} from "../fixtures/history-heavy-todo-052";

const identity={serverURL:"https://document-worker.example.test",userId:"owner"};
const encode=(document:Y.Doc)=>Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64");
async function fixture(t:any){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"anote-document-worker-052-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const session={profileRoot:directory,settings:{serverURL:identity.serverURL,user:{id:identity.userId},offline:true},token:null};
  const store=await new OfflineStore(session).load();t.after(()=>store.close());
  const document=prosemirrorJSONToYDoc(schema,{type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text:"需要保留的正文"}]}]},"default");t.after(()=>document.destroy());
  const input={id:"new-note",ystate:encode(document),metadata:{id:"new-note",space_id:"library",title:"后台正文",role:"admin"}};
  return {directory,session,store,document,input};
}

test("a 17 MiB history is read and merged in the worker, with only the small snapshot returned",async t=>{
  const f=await fixture(t),heavy=historyHeavyTodo052();t.after(()=>heavy.document.destroy());
  await f.store.persist();await fs.mkdir(path.join(f.store.root,"documents"),{recursive:true});
  await fs.writeFile(path.join(f.store.root,"documents/note.json"),JSON.stringify({metadata:{id:"note",role:"admin",title:"小正文大历史"},ystate:Buffer.from(heavy.update).toString("base64"),snapshot:heavy.snapshot,assets:[]}));
  const updates:Uint8Array[]=[];heavy.document.on("update",bytes=>updates.push(bytes));const list=heavy.document.getXmlFragment("default").get(0) as Y.XmlElement;((list.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0).insert(0,"新增");
  const delta=updates[0];assert.ok(delta.byteLength<512);
  let ticks=0,maxGap=0,last=performance.now(),preparedBytes=0;const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},5);
  try{
    const result=await runDocumentWorker({operation:"merge",sourceRoot:f.store.root,identity,id:"note",update:Buffer.from(delta).toString("base64")},undefined,(value:any)=>{
      preparedBytes=Buffer.byteLength(JSON.stringify(value));assert.ok(preparedBytes<100*1024);return {record:{metadata:{id:"note",role:"admin",title:"小正文大历史"},snapshot:value.snapshot,assets:[]}};
    });
    assert.equal(result.changed,true);assert.ok(result.threadId>0);assert.ok(Buffer.byteLength(JSON.stringify(result))<100*1024);assert.equal('ystate' in result.record,false);assert.equal('snapshot' in result.record,false);assert.ok(ticks>=5);assert.ok(maxGap<250,`parent event loop stalled ${maxGap}ms`);
  }finally{clearInterval(timer);}
  const saved=JSON.parse(await fs.readFile(path.join(f.store.root,"documents/note.json"),"utf8"));assert.ok(saved.ystate.length>20*1024*1024);assert.equal(saved.snapshot.content[0].content[0].content[0].content[0].text.startsWith("新增"),true);
});

test("a newly committed note repairs a failed index before an identical batch is acknowledged",async t=>{
  const f=await fixture(t),rename=fs.rename;
  const failure=t.mock.method(fs,"rename",async(source:string,target:string)=>{if(target===path.join(f.store.root,"index.json")&&f.store.data.documents[f.input.id])throw Object.assign(new Error("index full"),{code:"ENOSPC"});return rename(source,target);});
  await assert.rejects(()=>f.store.cacheDocument(f.input),{code:"ENOSPC"});assert.equal(f.store.indexDirty,true);
  const committed=JSON.parse(await fs.readFile(path.join(f.store.root,"documents/new-note.json"),"utf8"));assert.ok(committed.pending.opId);
  failure.mock.restore();await f.store.cacheDocument(f.input);assert.equal(f.store.indexDirty,false);await f.store.close();
  const reopened=await new OfflineStore(f.session).load();t.after(()=>reopened.close());assert.ok(reopened.data.documents[f.input.id]);assert.equal(reopened.data.documents[f.input.id].pending.opId,committed.pending.opId);assert.deepEqual((await reopened.previewRecord(f.input.id)).snapshot,committed.snapshot);
});

test("a worker exiting after atomic rename preserves committed pending state and retries through cold start",async t=>{
  const f=await fixture(t),entry=new URL("../../apps/desktop/main/document-worker.mjs",import.meta.url).href,worker=path.join(f.directory,"exit-after-commit.mjs");
  await fs.writeFile(worker,`import fs from 'node:fs/promises';const rename=fs.rename;fs.rename=async(source,target)=>{await rename(source,target);if(target===${JSON.stringify(path.join(f.store.root,"documents/new-note.json"))})process.exit(7);};await import(${JSON.stringify(entry)});`);
  f.store.documentWorker=worker;await assert.rejects(()=>f.store.cacheDocument(f.input),/意外退出（7）/);
  const committed=JSON.parse(await fs.readFile(path.join(f.store.root,"documents/new-note.json"),"utf8"));assert.equal(f.store.data.documents[f.input.id].pending.opId,committed.pending.opId);assert.equal(f.store.indexDirty,true);
  f.store.documentWorker=undefined;await f.store.cacheDocument(f.input);await f.store.close();
  const reopened=await new OfflineStore(f.session).load();t.after(()=>reopened.close());assert.equal(reopened.status().pending,1);assert.equal(reopened.data.documents[f.input.id].pending.opId,committed.pending.opId);assert.deepEqual((await reopened.previewRecord(f.input.id)).snapshot,committed.snapshot);
});

test("worker identity and symlink checks reject before a retained note can be replaced",async t=>{
  const f=await fixture(t);await f.store.cacheDocument(f.input);const file=path.join(f.store.root,"documents/new-note.json"),before=await fs.readFile(file,"utf8");
  const job={operation:"merge",sourceRoot:f.store.root,identity:{...identity,userId:"another-account"},id:f.input.id,update:f.input.ystate};
  await assert.rejects(runDocumentWorker(job,undefined,()=>{throw new Error("must not prepare another account");}),/不属于当前账号/);assert.equal(await fs.readFile(file,"utf8"),before);
  const outside=path.join(f.directory,"retained.json");await fs.writeFile(outside,before);await fs.unlink(file);await fs.symlink(outside,file);
  await assert.rejects(runDocumentWorker({...job,identity},undefined,()=>{throw new Error("must not prepare symlink");}),/符号链接/);assert.equal(await fs.readFile(outside,"utf8"),before);
});

import assert from "node:assert/strict";
import {test} from "node:test";
import * as Y from "yjs";
import {createDocumentUpdateCapture,deferredDocumentSave} from "../../apps/desktop/renderer/document-save";

const apply=(target:Y.Doc,batch:{ystate:string})=>Y.applyUpdate(target,Buffer.from(batch.ystate,"base64"));
const text=(document:Y.Doc)=>document.getText("visible").toString();

test("a tracker attached before hydration reuses the initial update without walking the full document again",()=>{
  const document=new Y.Doc(),source=new Y.Doc(),target=new Y.Doc(),capture=createDocumentUpdateCapture(document);
  source.getText("visible").insert(0,"一次完整载入");Y.applyUpdate(document,Y.encodeStateAsUpdate(source));
  const original=document.store.clients.forEach;document.store.clients.forEach=()=>{throw new Error("must not re-encode hydrated history");};
  try{const baseline=capture.capture();apply(target,baseline);capture.acknowledge(baseline);assert.equal(text(target),"一次完整载入");}
  finally{document.store.clients.forEach=original;capture.dispose();document.destroy();source.destroy();target.destroy();}
});

test("a small document with 17 MiB retained history saves tiny later changes without resending the history",()=>{
  const document=new Y.Doc(),target=new Y.Doc();
  document.getText("visible").insert(0,"待办正文");
  document.getMap("retained-migration-fixture").set("history","历史".repeat(3*1024*1024));
  const capture=createDocumentUpdateCapture(document);
  try{
    const baseline=capture.capture();assert.equal(baseline.isBaseline,true);assert.ok(Buffer.from(baseline.ystate,"base64").length>17*1024*1024);apply(target,baseline);capture.acknowledge(baseline);
    document.getText("visible").insert(4,"，新增几个字");
    const delta=capture.capture();assert.equal(delta.isBaseline,false);assert.ok(Buffer.from(delta.ystate,"base64").length<512);apply(target,delta);capture.acknowledge(delta);
    assert.equal(text(target),text(document));assert.equal(target.getMap("retained-migration-fixture").get("history"),document.getMap("retained-migration-fixture").get("history"));
  }finally{capture.dispose();document.destroy();target.destroy();}
});

test("an unacknowledged baseline and edits during its write remain retryable",()=>{
  const document=new Y.Doc(),target=new Y.Doc();document.getText("visible").insert(0,"最初");const capture=createDocumentUpdateCapture(document);
  try{
    const failed=capture.capture();document.getText("visible").insert(2,"，失败后续写");
    const retry=capture.capture();assert.equal(retry.isBaseline,true);apply(target,retry);capture.acknowledge(retry);assert.equal(text(target),text(document));
    // Even a late acknowledgement for an older baseline cannot discard a
    // newer batch: sequence boundaries, rather than an emptied array, are used.
    document.getText("visible").insert(document.getText("visible").length,"，最后");capture.acknowledge(failed);
    const last=capture.capture();assert.equal(last.isBaseline,false);apply(target,last);capture.acknowledge(last);assert.equal(text(target),text(document));
  }finally{capture.dispose();document.destroy();target.destroy();}
});

test("acknowledging an in-flight delta retains all updates made during that write",()=>{
  const document=new Y.Doc(),target=new Y.Doc();document.getText("visible").insert(0,"原稿");const capture=createDocumentUpdateCapture(document);
  try{
    const base=capture.capture();apply(target,base);capture.acknowledge(base);
    document.getText("visible").insert(2,"，第一批");const first=capture.capture();
    document.getText("visible").insert(document.getText("visible").length,"，写入时的新稿");apply(target,first);capture.acknowledge(first);
    const second=capture.capture();apply(target,second);capture.acknowledge(second);assert.equal(text(target),text(document));
    assert.deepEqual(Buffer.from(capture.capture().ystate,"base64"),Buffer.from([0,0]));
  }finally{capture.dispose();document.destroy();target.destroy();}
});

test("delete-only updates and remote structural updates are retained without a new client clock",()=>{
  const document=new Y.Doc(),target=new Y.Doc(),peer=new Y.Doc();document.getText("visible").insert(0,"需要删除的一段文字");const capture=createDocumentUpdateCapture(document);
  try{
    const base=capture.capture();apply(target,base);apply(peer,base);capture.acknowledge(base);
    const before=Y.encodeStateVector(document);document.getText("visible").delete(0,3);assert.deepEqual(Y.encodeStateVector(document),before);
    const deletion=capture.capture();apply(target,deletion);capture.acknowledge(deletion);assert.equal(text(target),text(document));
    peer.getMap("structure").set("block","远端新增节点");Y.applyUpdate(document,Y.encodeStateAsUpdate(peer,Y.encodeStateVector(document)),"remote");
    const remote=capture.capture();apply(target,remote);capture.acknowledge(remote);assert.equal(target.getMap("structure").get("block"),"远端新增节点");assert.equal(text(target),text(document));
  }finally{capture.dispose();document.destroy();target.destroy();peer.destroy();}
});

test("durable flush retries a failed delta and drains edits made while I/O was in flight",async()=>{
  const document=new Y.Doc(),target=new Y.Doc();document.getText("visible").insert(0,"正文");const capture=createDocumentUpdateCapture(document);let fail=false,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});let blocked=false;
  const saver=deferredDocumentSave({capture:()=>capture.capture(),write:async batch=>{if(fail)throw new Error("disk full");if(blocked)await gate;apply(target,batch);capture.acknowledge(batch);}});
  try{
    saver.markDirty();await saver.flush();fail=true;document.getText("visible").insert(2,"，首稿");saver.markDirty();await assert.rejects(()=>saver.flush(),/disk full/);
    fail=false;blocked=true;const writing=saver.flush();await Promise.resolve();document.getText("visible").insert(document.getText("visible").length,"，关闭前的新稿");saver.markDirty();saver.dispose();const closing=saver.flush();release();await Promise.all([writing,closing]);assert.equal(text(target),text(document));
  }finally{saver.dispose();capture.dispose();document.destroy();target.destroy();}
});

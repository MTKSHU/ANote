import assert from "node:assert/strict";
import {test} from "node:test";
import * as Y from "yjs";
import {cacheMetadata,deferredDocumentSave,encodeDocumentState} from "../../apps/desktop/renderer/document-save";

const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function gate(){let resolve!:()=>void,reject!:(reason:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test("typing bursts only capture after quiet time; explicit flush captures the newest revision",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let value="",captures=0;const writes:string[]=[];
  const saver=deferredDocumentSave({delay:350,capture:()=>{captures++;return value;},write:async text=>{writes.push(text);}});
  for(const character of "continuous typing"){value+=character;saver.markDirty();t.mock.timers.tick(20);await settle();}
  assert.equal(captures,0);assert.deepEqual(writes,[]);t.mock.timers.tick(349);await settle();assert.equal(captures,1);assert.deepEqual(writes,[value]);
  value+=" final";saver.markDirty();assert.equal(captures,1);await saver.flush();assert.equal(captures,2);assert.deepEqual(writes,["continuous typing",value]);saver.dispose();
});

test("one writer coalesces input during I/O and flush drains the last unsaved revision",async()=>{
  const first=gate(),writes:string[]=[];let value="first",active=0,max=0,captures=0;
  const saver=deferredDocumentSave({capture:()=>{captures++;return value;},write:async text=>{active++;max=Math.max(max,active);writes.push(text);try{if(writes.length===1)await first.promise;}finally{active--;}}});
  saver.markDirty();const flushing=saver.flush();await settle();assert.deepEqual(writes,["first"]);
  for(let i=0;i<20;i++){value="newest "+i;saver.markDirty();}const alsoFlushing=saver.flush();await settle();assert.equal(captures,1);assert.equal(max,1);
  first.resolve();await Promise.all([flushing,alsoFlushing]);assert.deepEqual(writes,["first","newest 19"]);assert.equal(captures,2);assert.equal(max,1);saver.dispose();
});

test("failed writes retain pending changes for explicit retry and do not spin in the background",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let fail=true,value="original";const writes:string[]=[],errors:unknown[]=[],pending:boolean[]=[];
  const saver=deferredDocumentSave({capture:()=>value,write:async text=>{writes.push(text);if(fail)throw new Error("disk full");},onError:error=>errors.push(error),onPending:value=>pending.push(value)});
  saver.markDirty();await assert.rejects(()=>saver.flush(),/disk full/);assert.equal(pending.at(-1),true);t.mock.timers.tick(10000);await settle();assert.equal(writes.length,1);assert.equal(errors.length,1);
  value="newest after failure";saver.markDirty();fail=false;await saver.flush();assert.deepEqual(writes,["original","newest after failure"]);assert.equal(pending.at(-1),false);saver.dispose();
});

test("capture failure keeps the revision recoverable and retry never writes a partial payload",async()=>{
  let failing=true,captures=0;const writes:string[]=[],errors:unknown[]=[];
  const saver=deferredDocumentSave({capture:()=>{captures++;if(failing)throw new Error("capture not ready");return "complete payload";},write:async text=>{writes.push(text);},onError:error=>errors.push(error)});
  saver.markDirty();await assert.rejects(()=>saver.flush(),/capture not ready/);assert.deepEqual(writes,[]);failing=false;await saver.flush();assert.deepEqual(writes,["complete payload"]);assert.equal(captures,2);assert.equal(errors.length,1);saver.dispose();
});

test("dispose stops automatic capture but shutdown flush still drains updates made during an earlier write",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let value="in flight";const first=gate(),writes:string[]=[];
  const saver=deferredDocumentSave({capture:()=>value,write:async text=>{writes.push(text);if(writes.length===1)await first.promise;}});
  saver.markDirty();t.mock.timers.tick(350);await settle();value="last edit before close";saver.markDirty();saver.dispose();const closing=saver.flush();t.mock.timers.tick(10000);await settle();assert.deepEqual(writes,["in flight"]);first.resolve();await closing;assert.deepEqual(writes,["in flight","last edit before close"]);
});

test("IME composition defers automatic capture until composition ends",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let composing=true,value="pinyin",captures=0;const writes:string[]=[];
  const saver=deferredDocumentSave({capture:()=>{captures++;return value;},write:async text=>{writes.push(text);},isComposing:()=>composing});
  saver.markDirty();for(let i=0;i<5;i++){t.mock.timers.tick(350);await settle();}assert.equal(captures,0);assert.deepEqual(writes,[]);
  composing=false;value="中文输入完成";saver.markDirty();t.mock.timers.tick(350);await settle();assert.deepEqual(writes,[value]);saver.dispose();
});

test("a temporarily read-only or unready document preserves its dirty revision for a later explicit flush",async()=>{
  let allowed=false;const writes:string[]=[];const saver=deferredDocumentSave({capture:()=>"retained draft",write:async text=>{writes.push(text);},canSave:()=>allowed});
  saver.markDirty();await saver.flush();assert.deepEqual(writes,[]);allowed=true;await saver.flush();assert.deepEqual(writes,["retained draft"]);saver.dispose();
});

test("native metadata excludes old body copies and the encoder preserves Unicode CRDT state",()=>{
  const metadata={id:"note",title:"当前标题",role:"admin",ystate:"large old state",snapshot:{large:"old body"},assets:[{large:"old assets"}],tags:["work"]},thin=cacheMetadata(metadata);
  assert.deepEqual(thin,{id:"note",title:"当前标题",role:"admin",tags:["work"]});assert.equal(metadata.ystate,"large old state");
  const document=new Y.Doc(),copy=new Y.Doc();try{document.getText("example").insert(0,"中文 📝 continuous text ".repeat(12000));const encoded=encodeDocumentState(document);assert.equal(encoded,Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"));Y.applyUpdate(copy,Buffer.from(encoded,"base64"));assert.equal(copy.getText("example").toString(),document.getText("example").toString());}finally{document.destroy();copy.destroy();}
});

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {test} from "node:test";
import {createSyncPendingIndicator} from "../../apps/desktop/renderer/document-save";
import {waitForDocumentSync} from "../../apps/desktop/renderer/persistence";

test("sync indicator publishes a binary pending value immediately and clears only after 120 ms",t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const changes:number[]=[],indicator=createSyncPendingIndicator(value=>changes.push(value));
  indicator.update(0);indicator.update(2);indicator.update(5);assert.deepEqual(changes,[1]);indicator.update(0);t.mock.timers.tick(119);assert.deepEqual(changes,[1]);t.mock.timers.tick(1);assert.deepEqual(changes,[1,0]);indicator.dispose();
});

test("repeated zero ACK notifications do not extend the quiet window or emit duplicate states",t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const changes:number[]=[],indicator=createSyncPendingIndicator(value=>changes.push(value));
  indicator.update(1);indicator.update(0);t.mock.timers.tick(60);indicator.update(0);t.mock.timers.tick(59);indicator.update(0);assert.deepEqual(changes,[1]);t.mock.timers.tick(1);assert.deepEqual(changes,[1,0]);indicator.update(0);t.mock.timers.tick(500);assert.deepEqual(changes,[1,0]);indicator.dispose();
});

test("new pending work cancels a scheduled clear and remains pending across a continuous input burst",t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const changes:number[]=[],indicator=createSyncPendingIndicator(value=>changes.push(value));
  indicator.update(1);
  for(let i=0;i<20;i++){indicator.update(0);t.mock.timers.tick(60);indicator.update(1);t.mock.timers.tick(60);}
  assert.deepEqual(changes,[1]);indicator.update(0);t.mock.timers.tick(119);assert.deepEqual(changes,[1]);t.mock.timers.tick(1);assert.deepEqual(changes,[1,0]);indicator.dispose();
});

test("disposing before provider destruction cancels scheduled callbacks and ignores later provider events",t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const changes:number[]=[],indicator=createSyncPendingIndicator(value=>changes.push(value));
  indicator.update(1);indicator.update(0);indicator.dispose();indicator.update(0);indicator.update(1);t.mock.timers.tick(1000);assert.deepEqual(changes,[1]);
});

test("actual sync wait uses provider truth independently of the delayed display and never clears while pending",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const changes:number[]=[],indicator=createSyncPendingIndicator(value=>changes.push(value));
  const provider=Object.assign(new EventEmitter(),{isSynced:true,hasUnsyncedChanges:true});let resolved=false;const waiting=waitForDocumentSync(provider as any).then(()=>{resolved=true;});
  indicator.update(3);t.mock.timers.tick(1000);await Promise.resolve();assert.equal(resolved,false);assert.deepEqual(changes,[1]);
  provider.hasUnsyncedChanges=false;provider.emit("unsyncedChanges");indicator.update(0);await waiting;assert.equal(resolved,true);assert.deepEqual(changes,[1]);t.mock.timers.tick(119);assert.deepEqual(changes,[1]);t.mock.timers.tick(1);assert.deepEqual(changes,[1,0]);indicator.dispose();
});

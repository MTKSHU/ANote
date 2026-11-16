import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentWorkerQueue,withDocumentWorker} from '../../apps/api/src/document-worker-queue';

function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}

test('large history preparations serialize and enforce count and byte admission before allocating snapshots',async()=>{
  const queue=new DocumentWorkerQueue({maxQueued:2,maxQueuedBytes:8,timeoutMs:10000}),gate=deferred(),started=deferred();let running=0,peak=0,copied=0;
  const first=queue.run(()=>async()=>{running++;peak=Math.max(peak,running);started.resolve();await gate.promise;running--;return 'first';},{bytes:8});await started.promise;
  let input='before';const second=queue.run(()=>{const snapshot=input;copied++;return async()=>{running++;peak=Math.max(peak,running);running--;return snapshot;};},{bytes:4});input='after';
  const third=queue.run(()=>{copied++;return async()=>'third';},{bytes:4});
  await assert.rejects(queue.run(()=>{copied++;return async()=>'overflow';},{bytes:0}),/任务较多/);
  assert.equal(copied,2);gate.resolve();assert.deepEqual(await Promise.all([first,second,third]),['first','before','third']);assert.equal(peak,1);
  const byteGate=deferred(),active=queue.run(()=>()=>byteGate.promise,{bytes:0}),queued=queue.run(()=>async()=>'queued',{bytes:8});
  await assert.rejects(queue.run(()=>{copied++;return async()=>'overflow';},{bytes:1}),/任务较多/);assert.equal(copied,2);byteGate.resolve();await Promise.all([active,queued]);
});
test('queued cancellation releases capacity and active cancellation waits for worker exit',async()=>{
  const queue=new DocumentWorkerQueue({maxQueued:1,maxQueuedBytes:8,timeoutMs:10000}),exit=deferred(),started=deferred(),cancelled=deferred();
  const controller=new AbortController();
  const active=queue.run(()=>async signal=>{started.resolve();signal.addEventListener('abort',()=>cancelled.resolve(),{once:true});await exit.promise;return 'late result';},{bytes:8,signal:controller.signal});await started.promise;
  const waitingController=new AbortController(),waiting=queue.run(()=>async()=>'must not start',{bytes:8,signal:waitingController.signal});waitingController.abort();await assert.rejects(waiting,/中止/);
  let nextStarted=false;const next=queue.run(()=>async()=>{nextStarted=true;return 'next';},{bytes:8});controller.abort();await cancelled.promise;
  assert.equal(nextStarted,false);exit.resolve();await assert.rejects(active,/中止/);assert.equal(await next,'next');
});
test('worker failures and preparation timeouts retain the original and release the slot',async()=>{
  const queue=new DocumentWorkerQueue({maxQueued:1,maxQueuedBytes:8,timeoutMs:20});
  await assert.rejects(queue.run(()=>async()=>{throw new Error('worker crashed');},{bytes:1}),/worker crashed/);
  await assert.rejects(queue.run(()=>signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),{bytes:1}),/超时.*原件保持不变/);
  assert.equal(await queue.run(()=>async()=>'recovered',{bytes:1}),'recovered');
  await assert.rejects(queue.run(()=>{throw new Error('snapshot copy failed');},{bytes:1}),/snapshot copy failed/);
  assert.equal(await queue.run(()=>async()=>'still available',{bytes:1}),'still available');
  await queue.run(()=>()=>Promise.reject(undefined),{bytes:1}).then(()=>assert.fail('undefined rejections must not become successful results'),reason=>assert.equal(reason,undefined));
});
test('queued deadlines free their reservations while an active worker finishes stopping',async()=>{
  const queue=new DocumentWorkerQueue({maxQueued:1,maxQueuedBytes:8,timeoutMs:20}),exit=deferred(),started=deferred();
  const active=queue.run(()=>async()=>{started.resolve();await exit.promise;},{bytes:8}),rejected=assert.rejects(active,/超时/);await started.promise;
  await assert.rejects(queue.run(()=>async()=>'expired queued operation',{bytes:8}),/超时.*原件保持不变/);
  let ran=false;const replacement=queue.run(()=>async()=>{ran=true;return 'replacement';},{bytes:8});assert.equal(ran,false);
  exit.resolve();await rejected;assert.equal(await replacement,'replacement');
});
test('history and maintenance callers share the same worker slot',async()=>{
  const exit=deferred(),started=deferred();let maintenanceStarted=false;
  const history=withDocumentWorker(async()=>{started.resolve();await exit.promise;return 'history';});await started.promise;
  const maintenance=withDocumentWorker(async()=>{maintenanceStarted=true;return 'maintenance';});assert.equal(maintenanceStarted,false);
  exit.resolve();assert.deepEqual(await Promise.all([history,maintenance]),['history','maintenance']);
});

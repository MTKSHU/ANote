import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DocumentSessionCache,type SessionResource} from '../../apps/desktop/renderer/document-session-cache';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
function setup(){
  let now=0;const pool=new DocumentSessionCache<{id:string}>({idleEntries:2,idleBytes:32,ttl:120000,now:()=>now});
  const records:{resource:SessionResource<{id:string}>;refreshes:number;flushes:number;disposals:number;forgotten:number;durable:boolean;wait:Promise<unknown>|null}[]=[];
  const create=(id:string,bytes=12)=>()=>{
    const record={resource:null as unknown as SessionResource<{id:string}>,refreshes:0,flushes:0,disposals:0,forgotten:0,durable:true,wait:null as Promise<unknown>|null};
    record.resource={value:{id},ready:Promise.resolve(),refresh:async()=>{record.refreshes++;},flush:async()=>{record.flushes++;if(record.wait)await record.wait;if(!record.durable)throw new Error('disk full');},deactivate:()=>{},dispose:async()=>{record.disposals++;},forget:async()=>{record.forgotten++;},bytes:()=>bytes,canEvict:()=>record.durable,usable:()=>!record.disposals&&!record.forgotten};records.push(record);return record.resource;
  };
  return {pool,records,create,time:(value:number)=>{now=value;}};
}
test('switching back reuses the live document without waiting for its tracked mirror checkpoint',async()=>{
  const {pool,records,create}=setup(),first=pool.acquire('account','a',create('a'));first.activate();await first.ready;
  const wait=gate();records[0].wait=wait.promise;first.release();await tick();
  const back=pool.acquire('account','a',create('must not create'));back.activate();let ready=false;void back.ready.then(()=>{ready=true;});await tick();assert.equal(ready,true);assert.equal(records[0].disposals,0);assert.equal(back.value,first.value);assert.equal(records.length,1);
  wait.resolve();await back.ready;assert.equal(records[0].refreshes,1);back.release();pool.clearOwner('account');await tick();await tick();assert.equal(records[0].forgotten,1);
});
test('LRU count and encoded-byte limits evict only durable inactive documents',async()=>{
  const {pool,records,create,time}=setup();
  for(let index=0;index<3;index++){time(index);const lease=pool.acquire('a',String(index),create(String(index),12));lease.activate();await lease.ready;lease.release();await tick();}
  await tick();assert.equal(records[0].disposals,1);assert.equal(pool.stats().retained,2);
  const active=pool.acquire('a','active',create('active',100));active.activate();await active.ready;pool.sweep();assert.equal(records[3].disposals,0);active.release();await tick();await tick();assert.equal(records[3].disposals,1);
  pool.clearOwner('a');await tick();
});
test('idle expiry frees resources and returning after expiry creates a new document',async()=>{
  const {pool,records,create,time}=setup(),lease=pool.acquire('a','note',create('first'));lease.activate();await lease.ready;lease.release();await tick();time(120001);pool.sweep();await tick();assert.equal(records[0].disposals,1);
  const next=pool.acquire('a','note',create('second'));next.activate();await next.ready;assert.notEqual(next.value,lease.value);next.release();pool.clearOwner('a');await tick();
});
test('token/account/server changes and explicit permission denial cannot reuse a prior document',async()=>{
  const {pool,records,create}=setup(),first=pool.acquire('server-a/user-a/token-a','note',create('private-a'));first.activate();await first.ready;
  const second=pool.acquire('server-b/user-b/token-b','note',create('private-b'));second.activate();await second.ready;assert.notEqual(first.value,second.value);first.release();await tick();await tick();assert.equal(records[0].forgotten,1);
  second.invalidate();second.release();await tick();await tick();const retry=pool.acquire('server-b/user-b/token-b','note',create('new-after-denial'));retry.activate();await retry.ready;assert.notEqual(retry.value,second.value);retry.release();pool.clearOwner('server-b/user-b/token-b');await tick();
});
test('a failed durable save is retained beyond the normal budget and flush can retry it',async()=>{
  const {pool,records,create,time}=setup(),lease=pool.acquire('a','draft',create('draft',100));lease.activate();await lease.ready;records[0].durable=false;lease.release();await tick();time(240000);pool.sweep();await tick();assert.equal(records[0].disposals,0);assert.equal(pool.stats().retained,1);
  await assert.rejects(pool.flush('a'),/disk full/);records[0].durable=true;await pool.flush('a');await tick();assert.equal(records[0].disposals,1);pool.clearOwner('a');
});
test('an abandoned render does not pin a session and later expiry disposes it',async()=>{
  const {pool,records,create,time}=setup();await pool.acquire('a','unused',create('unused')).ready;await tick();time(120001);pool.sweep();await tick();assert.equal(records[0].disposals,1);assert.equal(pool.stats().active,0);
});
test('a delayed old-owner cleanup cannot clear the new account session',async()=>{
  const {pool,records,create}=setup(),old=pool.acquire('old-token','note',create('old'));old.activate();await old.ready;
  const next=pool.acquire('new-token','note',create('new'));next.activate();await next.ready;pool.clearOwner('old-token');old.release();await tick();await tick();
  const again=pool.acquire('new-token','note',create('must-not-create'));again.activate();await again.ready;assert.equal(again.value,next.value);assert.equal(records.length,2);next.release();again.release();pool.clearOwner('new-token');await tick();
});

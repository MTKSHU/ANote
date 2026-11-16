import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {requireStateCapability,requireLegacyCompatibleUpdate,requireCompatibleDocumentUpdate} from '../../apps/api/src/document-state-policy.js';
import {withStateEncodingLock} from '../../apps/api/src/state-encoding-lock.js';
import {acquireDocument} from '../../apps/api/src/document-lock.js';
import {encodePositionMigration,decodePositionMigration} from '../../patches/y-tiptap-migration-codec.mjs';

const marker=(doc:Y.Doc,value:unknown)=>doc.getMap('__anote_sync_meta').set('migrationEncoding',value);
const unchanged=(doc:Y.Doc,operation:()=>void)=>{const before=Y.encodeStateAsUpdate(doc);assert.throws(operation);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);};
const migration={version:1 as const,client:7,clock:1,seen:[] as [number,number][],transfers:[{source:{client:3,clock:10,length:1},target:null}]};

test('encoding 2 fences every missing, old, invalid or nonfinite capability while encoding 1 remains compatible',()=>{
  for(const capability of [undefined,null,0,1,'1',NaN,Infinity,'garbage'])assert.throws(()=>requireStateCapability(2,capability));
  assert.throws(()=>requireStateCapability(2,1),(error:any)=>error.getStatus()===409&&error.reason.includes('更新桌面客户端'));
  for(const capability of [2,'2',3])assert.doesNotThrow(()=>requireStateCapability(2,capability));
  for(const capability of [undefined,1,2])assert.doesNotThrow(()=>requireStateCapability(1,capability));
});

test('a marker replacement inherits its root from a deleted item inside the same update and cannot upgrade encoding 1',()=>{
  const server=new Y.Doc(),client=new Y.Doc();try{
    marker(client,1);marker(client,2);const update=Y.encodeStateAsUpdate(client),items=Y.decodeUpdate(update).structs.filter((item):item is Y.Item=>item instanceof Y.Item);
    assert(items.some(item=>item.parent===null&&item.origin));assert(items.some(item=>item.content instanceof Y.ContentDeleted));
    unchanged(server,()=>requireLegacyCompatibleUpdate(server,update));
    for(const future of [3,'2',undefined,null,false,{version:2}]){const candidate=new Y.Doc();try{marker(candidate,1);marker(candidate,future);unchanged(server,()=>requireLegacyCompatibleUpdate(server,Y.encodeStateAsUpdate(candidate)));}finally{candidate.destroy();}}
  }finally{server.destroy();client.destroy();}
});

test('dependent updates cannot be parked to upgrade a marker when a later ancestor arrives, including existing pending state',()=>{
  const server=new Y.Doc(),legacyPending=new Y.Doc(),client=new Y.Doc();try{
    marker(client,1);const first=Y.encodeStateAsUpdate(client),vector=Y.encodeStateVector(client);marker(client,2);const dependent=Y.encodeStateAsUpdate(client,vector);
    unchanged(server,()=>requireLegacyCompatibleUpdate(server,dependent));assert.equal(server.store.pendingStructs,null);
    // Exercise a pre-existing pending update left by an earlier server version.
    Y.applyUpdate(legacyPending,dependent);assert(legacyPending.store.pendingStructs);unchanged(legacyPending,()=>requireLegacyCompatibleUpdate(legacyPending,first));
    requireLegacyCompatibleUpdate(server,first);Y.applyUpdate(server,first);assert.equal(server.getMap('__anote_sync_meta').get('migrationEncoding'),1);
    unchanged(server,()=>requireLegacyCompatibleUpdate(server,dependent));
  }finally{server.destroy();legacyPending.destroy();client.destroy();}
});

test('binary migrations require server opt-in, while previously integrated binary history can be replayed after lossless expansion',()=>{
  const server=new Y.Doc(),client=new Y.Doc();try{
    const map=client.getMap('__tiptap_position_migrations:root:default');map.set('record',encodePositionMigration(migration));marker(client,2);const previous=Y.encodeStateAsUpdate(client);
    unchanged(server,()=>requireLegacyCompatibleUpdate(server,previous));
    // An explicit server rollback retains identity/deletion information.
    Y.applyUpdate(server,previous);const serverMap=server.getMap<any>('__tiptap_position_migrations:root:default');serverMap.set('record',decodePositionMigration(serverMap.get('record')));server.getMap('__anote_sync_meta').delete('migrationEncoding');const expanded=Y.encodeStateAsUpdate(server);
    requireLegacyCompatibleUpdate(server,previous);Y.applyUpdate(server,previous);assert.deepEqual(Y.encodeStateAsUpdate(server),expanded);
  }finally{server.destroy();client.destroy();}
});

test('complete new and incremental nested text updates remain compatible, including right-origin and partial replay',()=>{
  const server=new Y.Doc(),client=new Y.Doc();try{
    const nested=new Y.Map(),text=new Y.Text();client.getMap('body').set('nested',nested);nested.set('text',text);text.insert(0,'world');marker(client,1);
    const first=Y.encodeStateAsUpdate(client);requireLegacyCompatibleUpdate(server,first);Y.applyUpdate(server,first);
    const vector=Y.encodeStateVector(client);text.insert(0,'hello ');const delta=Y.encodeStateAsUpdate(client,vector);assert(Y.decodeUpdate(delta).structs.some(item=>item instanceof Y.Item&&item.rightOrigin));requireLegacyCompatibleUpdate(server,delta);Y.applyUpdate(server,delta);
    requireLegacyCompatibleUpdate(server,first);requireLegacyCompatibleUpdate(server,Y.encodeStateAsUpdate(client));Y.applyUpdate(server,Y.encodeStateAsUpdate(client));assert.equal((server.getMap('body').get('nested') as Y.Map<any>).get('text').toString(),'hello world');
  }finally{server.destroy();client.destroy();}
});

test('encoding 2 accepts valid legacy and compact records but rejects malformed binary, future markers and marker removal',()=>{
  const server=new Y.Doc(),client=new Y.Doc();try{
    marker(server,2);Y.applyUpdate(client,Y.encodeStateAsUpdate(server));let vector=Y.encodeStateVector(client);const map=client.getMap('__tiptap_position_migrations:root:default');map.set('legacy',migration);map.set('compact',encodePositionMigration(migration));const valid=Y.encodeStateAsUpdate(client,vector);requireCompatibleDocumentUpdate(server,valid,2);Y.applyUpdate(server,valid);
    vector=Y.encodeStateVector(client);map.set('malformed',Uint8Array.from([65,78,77,2]));unchanged(server,()=>requireCompatibleDocumentUpdate(server,Y.encodeStateAsUpdate(client,vector),2));map.delete('malformed');
    vector=Y.encodeStateVector(client);marker(client,3);unchanged(server,()=>requireCompatibleDocumentUpdate(server,Y.encodeStateAsUpdate(client,vector),2));
    const removal=new Y.Doc();try{Y.applyUpdate(removal,Y.encodeStateAsUpdate(server));const baseline=Y.encodeStateVector(removal);removal.getMap('__anote_sync_meta').delete('migrationEncoding');unchanged(server,()=>requireCompatibleDocumentUpdate(server,Y.encodeStateAsUpdate(removal,baseline),2));}finally{removal.destroy();}
    const malformed=new Y.Doc();try{Y.applyUpdate(malformed,Y.encodeStateAsUpdate(server));const baseline=Y.encodeStateVector(malformed);malformed.getMap('__tiptap_position_migrations:root:default').set('record',{...migration,clock:-1});unchanged(server,()=>requireCompatibleDocumentUpdate(server,Y.encodeStateAsUpdate(malformed,baseline),2));}finally{malformed.destroy();}
  }finally{server.destroy();client.destroy();}
});

test('a late edit under a garbage-collected deleted parent is harmless and does not cause a reconnect loop',()=>{
  const server=new Y.Doc(),client=new Y.Doc();try{
    const nested=new Y.Map(),text=new Y.Text();client.getMap('body').set('deleted',nested);nested.set('text',text);text.insert(0,'old text');Y.applyUpdate(server,Y.encodeStateAsUpdate(client));const baseline=Y.encodeStateVector(client);
    server.getMap('body').delete('deleted');text.insert(2,'late');const late=Y.encodeStateAsUpdate(client,baseline);assert([...server.store.clients.values()].some(rows=>rows.some(item=>item instanceof Y.GC)));
    requireCompatibleDocumentUpdate(server,late,1);Y.applyUpdate(server,late);assert.equal(server.getMap('body').has('deleted'),false);
  }finally{server.destroy();client.destroy();}
});

test('a normal SyncStep1/SyncStep2 reconnect replays an already deleted marker tombstone without rejecting an offline text edit',()=>{
  const server=new Y.Doc(),client=new Y.Doc();try{
    server.getText('body').insert(0,'original');server.getMap('__tiptap_position_migrations:root:default').set('binary',encodePositionMigration(migration));marker(server,2);
    // A missing visible marker does not downgrade an encoding-2 document.
    // A loaded/merged Yjs state can retain the deleted map item internally.
    server.getMap('__anote_sync_meta').delete('migrationEncoding');const tombstone=server.getMap('__anote_sync_meta')._map.get('migrationEncoding')!;assert(tombstone.deleted);
    Y.applyUpdate(client,Y.encodeStateAsUpdate(server));client.getText('body').insert(8,' offline');
    const first=encoding.createEncoder();sync.writeSyncStep1(first,server);const firstDecoder=decoding.createDecoder(encoding.toUint8Array(first));assert.equal(decoding.readVarUint(firstDecoder),sync.messageYjsSyncStep1);
    const reply=encoding.createEncoder();sync.readSyncStep1(firstDecoder,reply,client);const replyDecoder=decoding.createDecoder(encoding.toUint8Array(reply));assert.equal(decoding.readVarUint(replyDecoder),sync.messageYjsSyncStep2);const update=decoding.readVarUint8Array(replyDecoder);
    assert(Y.isDeleted(Y.decodeUpdate(update).ds,tombstone.id));requireCompatibleDocumentUpdate(server,update,2);Y.applyUpdate(server,update);assert.equal(server.getText('body').toString(),'original offline');
    const again=Y.encodeStateAsUpdate(client,Y.encodeStateVector(server));requireCompatibleDocumentUpdate(server,again,2);Y.applyUpdate(server,again);assert.equal(server.getText('body').toString(),'original offline');
  }finally{server.destroy();client.destroy();}
});

test('the edit and encoding gates keep the same acquisition order for API load and maintenance without nested edit locking',async()=>{
  const id='lock-regression-054',events:string[]=[],release=await acquireDocument(id);
  const loading=withStateEncodingLock(id,async()=>{events.push('load');});
  const maintenance=(async()=>{const unlock=await acquireDocument(id);try{return await withStateEncodingLock(id,async()=>{events.push('maintenance');});}finally{unlock();}})();
  await loading;events.push('api-done');release();await maintenance;assert.deepEqual(events,['load','api-done','maintenance']);
  await assert.rejects(withStateEncodingLock(id,async()=>{throw new Error('failed load');}),/failed load/);await withStateEncodingLock(id,async()=>{events.push('recovered');});assert.equal(events.at(-1),'recovered');
});

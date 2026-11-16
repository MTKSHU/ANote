import {test,expect,type Page} from '@playwright/test';
import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {compactDocumentMigrationValues} from '@anote/document-model/migration-codec';
import {api,admin} from './helpers';
import {person} from './mcp-helpers';

let script:string;
test.beforeAll(async()=>{
  const result=await build({bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',globalName:'anoteLifecycle',logLevel:'silent',stdin:{resolveDir:process.cwd(),contents:`
    export * as Y from 'yjs';export * as codec from '@anote/document-model/migration-codec';
    export * as protocol from './apps/desktop/renderer/document-migration-protocol.ts';
    export * as sessions from './apps/desktop/renderer/document-session.ts';
    export * as repair from './apps/desktop/renderer/document-preview-repair-core.ts';
    export {IndexeddbPersistence,storeState} from 'y-indexeddb';export {flushDocumentUpdates} from './apps/desktop/renderer/persistence.ts';
    export {schema} from '@anote/document-model';export {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
    export async function seed(name,bytes){const database=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{request.result.createObjectStore('updates',{autoIncrement:true});request.result.createObjectStore('custom');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{await new Promise((resolve,reject)=>{const transaction=database.transaction('updates','readwrite');transaction.objectStore('updates').add(bytes);transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);});}finally{database.close();}}
    export async function stored(database){return new Promise((resolve,reject)=>{const transaction=database.transaction('updates','readonly'),values=transaction.objectStore('updates').getAll();transaction.oncomplete=()=>resolve({updates:values.result,bytes:values.result.reduce((sum,value)=>sum+value.byteLength,0)});transaction.onerror=()=>reject(transaction.error);});}
    export async function retire(lease){const done=new Promise(resolve=>lease.value.document.once('destroy',resolve));lease.invalidate();lease.release();await done;}
  `}});script=result.outputFiles![0].text;
});
async function harness(page:Page){await page.goto('/');await page.route('**/__tests/document-lifecycle.js',route=>route.fulfill({contentType:'application/javascript',body:script}));await page.addScriptTag({url:new URL('/__tests/document-lifecycle.js',page.url()).href});}

test('fresh sessions restore an existing encoding2 marker without advancing its state vector',async({page},testInfo)=>{
  await harness(page);
  const result=await page.evaluate(async id=>{
    const h=(window as any).anoteLifecycle,state={desktop:false,serverURL:location.origin,user:{id:'lifecycle-owner',role:'admin'},token:'local-test-no-socket',workspace:'',offline:true},name=`anote:${state.serverURL}:${state.user.id}:${id}`;
    const original=h.prosemirrorJSONToYDoc(h.schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:'retained'},content:[{type:'text',text:'不编辑的原稿'}]}]},'default');h.codec.setDocumentMigrationEncoding(original,2);
    const expected=Array.from(h.Y.encodeStateVector(original)),marker=JSON.stringify(original.getMap('__anote_sync_meta')._map.get('migrationEncoding').id),runs=[];
    await h.seed(name,h.Y.encodeStateAsUpdate(original));
    for(let index=0;index<3;index++){
      const lease=h.sessions.acquireDocumentSession(state,id,2);lease.activate();let protocolWrites=0;
      lease.value.document.on('update',(_bytes:Uint8Array,origin:unknown)=>{if(origin===h.protocol.DOCUMENT_PROTOCOL_ORIGIN)protocolWrites++;});
      lease.value.authorize({id,title:'不编辑的原稿',role:'admin',state_encoding:2},false);
      const beforeHydrate=Array.from(h.Y.encodeStateVector(lease.value.document));await lease.ready;
      runs.push({beforeHydrate,vector:Array.from(h.Y.encodeStateVector(lease.value.document)),marker:JSON.stringify(lease.value.document.getMap('__anote_sync_meta')._map.get('migrationEncoding').id),protocolWrites});await h.retire(lease);
    }
    original.destroy();return {expected,marker,runs};
  },'fresh-'+randomUUID());
  expect(result.runs).toHaveLength(3);for(const run of result.runs){expect(run.beforeHydrate).toEqual([0]);expect(run.vector).toEqual(result.expected);expect(run.marker).toBe(result.marker);expect(run.protocolWrites).toBe(0);}
  await testInfo.attach('fresh-marker-vector.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});

test('legacy cache gets one protocol transaction and native local dirty flags require a body edit',async({page},testInfo)=>{
  await harness(page);
  const result=await page.evaluate(async id=>{
    const h=(window as any).anoteLifecycle,writes:any[]=[];
    // This white-box lifecycle test spies only on the IPC write boundary; it
    // never replaces web application identity, authorization or routing.
    (window as any).anote={cacheOfflineDocument:async(value:any)=>{writes.push({local:value.local,metadata:value.metadata});}};
    const state={desktop:true,serverURL:location.origin,user:{id:'lifecycle-native-owner',role:'admin'},token:'local-test-no-socket',workspace:'',offline:true},name=`anote:${state.serverURL}:${state.user.id}:${id}`,original=h.prosemirrorJSONToYDoc(h.schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:'native-body'},content:[{type:'text',text:'原始正文'}]}]},'default');
    await h.seed(name,h.Y.encodeStateAsUpdate(original));const runs=[],metadata={id,title:'协议不等于正文编辑',role:'admin',state_encoding:2};let firstVector:any;
    for(let index=0;index<3;index++){
      const lease=h.sessions.acquireDocumentSession(state,id,2);lease.activate();let protocolWrites=0;
      lease.value.document.on('update',(_bytes:Uint8Array,origin:unknown)=>{if(origin===h.protocol.DOCUMENT_PROTOCOL_ORIGIN)protocolWrites++;});
      lease.value.authorize(metadata,false);const beforeHydrate=Array.from(h.Y.encodeStateVector(lease.value.document));await lease.ready;lease.value.authorize(metadata,true);await lease.value.saveNative();
      const vector=Array.from(h.Y.encodeStateVector(lease.value.document));if(index===0)firstVector=vector;runs.push({beforeHydrate,protocolWrites,vector});
      if(index===2){const beforeEdit=writes.length,paragraph=lease.value.document.getXmlFragment('default').get(0),text=paragraph.get(0);text.insert(text.length,' 用户新写入');await lease.value.saveNative();const userWrites=writes.slice(beforeEdit);await h.retire(lease);original.destroy();return {runs,firstVector,protocolPayloads:writes.slice(0,beforeEdit),userWrites};}
      await h.retire(lease);
    }
    throw new Error('Missing lifecycle run');
  },'legacy-'+randomUUID());
  expect(result.runs.map(run=>run.protocolWrites)).toEqual([1,0,0]);for(const run of result.runs){expect(run.beforeHydrate).toEqual([0]);expect(run.vector).toEqual(result.firstVector);}expect(result.protocolPayloads.length).toBeGreaterThan(0);expect(result.protocolPayloads.every(value=>value.local===false)).toBe(true);expect(result.userWrites.some(value=>value.local===true)).toBe(true);
  await testInfo.attach('protocol-versus-user-edit.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});

test('fresh readonly viewer receives the server encoding2 marker and completes synchronization without local structs',async({page,request},testInfo)=>{
  const origin=process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3190';expect(['http://127.0.0.1:3190','http://127.0.0.1:3200','http://127.0.0.1:3210']).toContain(origin);
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe(origin);expect(process.env.DB_PASSWORD).toBeTruthy();
  const owner=await admin(request),viewer=await person(request),suffix=randomUUID(),book=await api(request,'POST','spaces',{kind:'personal',name:'QA054 readonly marker '+suffix},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'QA054 readonly marker '+suffix},owner);
  const snapshot=schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'只读首开必须完整同步 '+suffix}]}]}).toJSON(),seed=prosemirrorJSONToYDoc(schema,snapshot,'default'),history=seed.getMap('__tiptap_position_migrations:root:default');
  history.set('synthetic:1',{version:1,client:2147483646,clock:1,seen:[],transfers:[{source:{client:2147483645,clock:1000,length:1},target:{client:2147483644,clock:2000,type:{client:2147483644,clock:0},assoc:0}}]});compactDocumentMigrationValues(seed);
  const expectedVector=Array.from(Y.encodeStateVector(seed)),expectedMarker=JSON.stringify((seed.getMap('__anote_sync_meta') as any)._map.get('migrationEncoding').id),sql=new Pool({host:'db',database:'anote',user:'anote',password:process.env.DB_PASSWORD,application_name:'anote-qa054-new-readonly-fixture'});
  try{
    const injected=await sql.query('UPDATE documents SET ystate=$1,snapshot=$2,state_encoding=2 WHERE id=$3 AND space_id=$4 AND created_by=$5 AND title=$6 RETURNING id',[Buffer.from(Y.encodeStateAsUpdate(seed)),snapshot,note.id,book.id,owner.user.id,note.title]);expect(injected.rowCount).toBe(1);
    const sharing=await api(request,'GET',`documents/${note.id}/sharing`,undefined,owner);await api(request,'PATCH',`documents/${note.id}/sharing`,{visibility:'private',access_revision:sharing.access_revision,collaborators:[{user_id:viewer.user.id,role:'viewer'}]},owner);
    const metadata=await api(request,'GET',`documents/${note.id}?content=metadata`,undefined,viewer);expect(metadata.role).toBe('viewer');expect(metadata.state_encoding).toBe(2);
    await harness(page);
    const result=await page.evaluate(async({id,user,token,metadata})=>{
      const h=(window as any).anoteLifecycle,state={desktop:false,serverURL:location.origin,user,token,workspace:'',offline:false},lease=h.sessions.acquireDocumentSession(state,id,2);lease.activate();let localUpdates=0;const failures:string[]=[];
      lease.value.document.on('update',(_bytes:Uint8Array,_origin:unknown,_document:any,transaction:any)=>{if(transaction.local)localUpdates++;});
      const remove=lease.value.subscribe({status:()=>{},synced:()=>{},pending:()=>{},failed:(reason:string)=>failures.push(reason),saveError:(error:Error)=>failures.push(error.message)});
      await lease.ready;const beforeSync={vector:Array.from(h.Y.encodeStateVector(lease.value.document)),hasMarker:lease.value.document.share.has('__anote_sync_meta')};lease.value.authorize(metadata,true);await lease.value.socket.connect();
      await new Promise<void>((resolve,reject)=>{const provider=lease.value.provider;const check=()=>{if(provider.isSynced&&!provider.hasUnsyncedChanges){clearTimeout(timer);provider.off('synced',check);provider.off('unsyncedChanges',check);resolve();}};const timer=setTimeout(()=>reject(new Error('Readonly provider did not ACK its initial sync: '+failures.join('; '))),30000);provider.on('synced',check);provider.on('unsyncedChanges',check);check();});
      const value={beforeSync,localUpdates,failures,synced:lease.value.provider.isSynced,unsyncedChanges:lease.value.provider.unsyncedChanges,hasUnsyncedChanges:lease.value.provider.hasUnsyncedChanges,vector:Array.from(h.Y.encodeStateVector(lease.value.document)),marker:JSON.stringify(lease.value.document.getMap('__anote_sync_meta')._map.get('migrationEncoding').id),body:lease.value.document.getXmlFragment('default').toString()};remove();await h.retire(lease);return value;
    },{id:note.id,user:viewer.user,token:viewer.token,metadata});
    expect(result.beforeSync).toEqual({vector:[0],hasMarker:false});expect(result.localUpdates).toBe(0);expect(result.failures).toEqual([]);expect(result.synced).toBe(true);expect(result.unsyncedChanges).toBe(0);expect(result.hasUnsyncedChanges).toBe(false);expect(result.vector).toEqual(expectedVector);expect(result.marker).toBe(expectedMarker);expect(result.body).toContain('只读首开必须完整同步 '+suffix);
    await testInfo.attach('fresh-readonly-provider.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
  }finally{seed.destroy();await sql.end();}
});

test('a later external stale baseline is repaired again without changing content, pending state or its state vector',async({page},testInfo)=>{
  await harness(page);
  const result=await page.evaluate(async name=>{
    const h=(window as any).anoteLifecycle,original=h.prosemirrorJSONToYDoc(h.schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:'draft'},content:[{type:'text',text:'必须保留的原稿与待同步修改'}]}]},'default'),history=original.getMap('__tiptap_position_migrations:root:default');
    original.transact(()=>{for(let record=0;record<562;record++){const transfers=[];for(let index=0;index<286;index++){const clock=100000+record*286+index;transfers.push({source:{client:2147483645,clock:clock*2,length:1},target:{client:2147483644,clock:clock*3,type:{client:2147483644,clock:0},assoc:0}});}history.set('history:'+record,{version:1,client:2147483646,clock:record+1,seen:record?[[2147483646,record]]:[],transfers});}});
    original.getMap('pending-local').set('initial','原始待同步修改');const legacy=h.Y.encodeStateAsUpdate(original),retained=new h.Y.Doc(),externalStale=new h.Y.Doc();h.Y.applyUpdate(retained,legacy);h.Y.applyUpdate(externalStale,legacy);await h.seed(name,legacy);
    const persistence=new h.IndexeddbPersistence(name,retained);await persistence.whenSynced;const first=await h.repair.repairDocumentDatabase(name),stillLegacy=h.codec.scanDocumentMigrationEncoding(retained);
    // y-indexeddb's real storeState reads the worker checkpoint before encoding
    // the retained Doc, so an ordinary same-version flush does not regress it.
    await h.storeState(persistence,true);await h.flushDocumentUpdates(persistence);const ordinary=await h.stored(persistence.db),ordinaryEncoding=h.codec.scanDocumentMigrationEncoding(retained);await persistence.destroy();
    // A deliberately external writer starts a new persistence with a preloaded
    // stale Doc: its constructor really appends the old full baseline before
    // hydrating the newer checkpoint. This is not the current session factory.
    externalStale.getMap('pending-local').set('late','外来writer新增加的待同步修改');const stalePersistence=new h.IndexeddbPersistence(name,externalStale);await stalePersistence.whenSynced;await h.flushDocumentUpdates(stalePersistence);const afterReplay=await h.stored(stalePersistence.db),beforeVector=Array.from(h.Y.encodeStateVector(externalStale)),beforeBody=externalStale.getXmlFragment('default').toString(),second=await h.repair.repairDocumentDatabase(name),afterSecond=await h.stored(stalePersistence.db);
    const restored=new h.Y.Doc();for(const update of afterSecond.updates)h.Y.applyUpdate(restored,update);
    const recovery:any=await new Promise((resolve,reject)=>{const transaction=stalePersistence.db.transaction('custom','readonly'),request=transaction.objectStore('custom').get(h.repair.DOCUMENT_REPAIR_RECOVERY);transaction.oncomplete=()=>resolve(request.result);transaction.onerror=()=>reject(transaction.error);});
    const recoveryDoc=new h.Y.Doc();h.Y.applyUpdate(recoveryDoc,recovery.ystate);
    const getAll=IDBObjectStore.prototype.getAll;let payloadReads=0;IDBObjectStore.prototype.getAll=function(...args:any[]){if(this.name==='updates'){payloadReads++;throw new Error('An unchanged checkpoint must not read update values');}return (getAll as any).apply(this,args);};let unchanged:any;try{unchanged=await h.repair.repairDocumentDatabase(name);}finally{IDBObjectStore.prototype.getAll=getAll;}
    const value={legacyBytes:legacy.byteLength,first:first.status,retainedEncodingBeforeFlush:stillLegacy,ordinaryEncoding,ordinaryBytes:ordinary.bytes,afterExternalReplayBytes:afterReplay.bytes,second:second.status,afterSecondBytes:afterSecond.bytes,unchanged:unchanged.status,payloadReads,sameVector:JSON.stringify(Array.from(h.Y.encodeStateVector(restored)))===JSON.stringify(beforeVector),sameBody:restored.getXmlFragment('default').toString()===beforeBody,pending:restored.getMap('pending-local').toJSON(),recoveryPending:recoveryDoc.getMap('pending-local').toJSON(),recoverySameBody:recoveryDoc.getXmlFragment('default').toString()===beforeBody,note:'Ordinary retained persistence flush first reads the compact checkpoint. A later external baseline/tail invalidates the key fence and is merged losslessly.'};await stalePersistence.destroy();original.destroy();retained.destroy();externalStale.destroy();restored.destroy();recoveryDoc.destroy();return value;
  },'external-replay-'+randomUUID());
  expect(result.legacyBytes).toBeGreaterThan(16*1024*1024);expect(result.first).toBe('repaired');expect(result.retainedEncodingBeforeFlush).toBe(1);expect(result.ordinaryEncoding).toBe(2);expect(result.ordinaryBytes).toBeLessThan(result.legacyBytes*.3);expect(result.afterExternalReplayBytes).toBeGreaterThan(result.legacyBytes);expect(result.second).toBe('repaired');expect(result.afterSecondBytes).toBeLessThan(result.legacyBytes*.3);expect(result.unchanged).toBe('already-repaired');expect(result.payloadReads).toBe(0);expect(result.sameVector).toBe(true);expect(result.sameBody).toBe(true);expect(result.pending).toEqual({initial:'原始待同步修改',late:'外来writer新增加的待同步修改'});expect(result.recoveryPending).toEqual(result.pending);expect(result.recoverySameBody).toBe(true);
  await testInfo.attach('external-writer-diagnostic.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});

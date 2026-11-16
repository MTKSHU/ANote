import {test,expect,type Page,type APIRequestContext} from '@playwright/test';
import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {api,login} from './helpers';
import {person} from './mcp-helpers';

let harness:string,workerScript:string;
test.beforeAll(async({request})=>{
  expect(process.env.ANOTE_ISOLATED_TESTS,'Explicit isolated QA authorization').toBe('1');
  const origin=process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3190';
  expect(['http://127.0.0.1:3190','http://127.0.0.1:3200']).toContain(origin);
  expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe(origin);
  const options={bundle:true,write:false,platform:'browser' as const,format:'iife' as const,target:'es2022',logLevel:'silent' as const};
  const [browser,worker]=await Promise.all([
    build({...options,globalName:'anotePreviewTest',stdin:{resolveDir:process.cwd(),contents:`export * as cache from './apps/desktop/renderer/document-preview-cache.ts';export * as repair from './apps/desktop/renderer/document-preview-repair-core.ts';export * as Y from 'yjs';export {IndexeddbPersistence} from 'y-indexeddb';export {trackDocumentPersistence} from './apps/desktop/renderer/document-cache-persistence.ts';export {schema} from '@anote/document-model';export {prosemirrorJSONToYDoc,initProseMirrorDoc} from '@tiptap/y-tiptap';export {findAnchor,resolveAnchor} from '@anote/document-model/anchors';`}}),
    build({...options,entryPoints:['apps/desktop/renderer/document-preview-repair.worker.ts']}),
  ]);harness=browser.outputFiles![0].text;workerScript=worker.outputFiles![0].text;
});
const paragraph=(text:string)=>({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]});
async function installHarness(page:Page){
  // Keep the production CSP: serve the test bundle as a same-origin script.
  await page.route('**/__tests/document-preview-harness.js',route=>route.fulfill({contentType:'application/javascript',body:harness}));
  await page.addScriptTag({url:new URL('/__tests/document-preview-harness.js',page.url()).href});
}
async function fixture(request:APIRequestContext){
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'正文首屏验证'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'首屏独立预览'},owner),reference=await api(request,'POST','documents',{space_id:book.id,title:'可读的参考笔记'},owner);
  const snapshot={type:'doc',content:[{type:'taskList',attrs:{blockId:randomUUID()},content:[{type:'taskItem',attrs:{checked:false},content:[paragraph('只读预览不能修改这个待办')]}]},paragraph('轻量预览正文 '+note.id),{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'可读的参考笔记',marks:[{type:'link',attrs:{href:'/?doc='+reference.id,target:null,rel:null}}]}]}]},document=prosemirrorJSONToYDoc(schema,snapshot,'default');
  try{await api(request,'POST',`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,migrationEncoding:2,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')},owner);}finally{document.destroy();}
  return {owner,book,note,snapshot,reference};
}

test('lightweight cache validates owner and the last update key without reading update payloads',async({page})=>{
  await page.goto('/');await installHarness(page);
  const result=await page.evaluate(async()=>{
    const h=(window as any).anotePreviewTest,state={serverURL:'https://preview.invalid',user:{id:'owner'},workspace:'personal'},id='cache-note',snapshot={type:'doc',content:[{type:'paragraph',attrs:{blockId:'body'},content:[{type:'text',text:'尚未上传的本机草稿'}]}]};
    const document=h.prosemirrorJSONToYDoc(h.schema,snapshot,'default'),persistence=new h.IndexeddbPersistence(h.cache.documentDatabaseName(state,id),document),tracker=h.trackDocumentPersistence(document,persistence);
    await persistence.whenSynced;await tracker.refresh();await h.cache.writeDocumentPreview(persistence,state,id,{id,title:'草稿',revision:4,access_revision:7},snapshot,true);
    const original=IDBObjectStore.prototype.getAll;let payloadReads=0;
    IDBObjectStore.prototype.getAll=function(...args:any[]){if(this.name==='updates'){payloadReads++;throw new Error('Preview must not read update values');}return (original as any).apply(this,args);};
    let cached:any,wrongOwner:any;try{cached=await h.cache.readDocumentPreview(state,id);wrongOwner=await h.cache.readDocumentPreview({...state,workspace:'team:other'},id);}finally{IDBObjectStore.prototype.getAll=original;}
    const peer=new h.Y.Doc();peer.getMap('other-tab').set('draft','另一标签页的更新');
    await new Promise<void>((resolve,reject)=>{const tx=persistence.db.transaction('updates','readwrite');tx.objectStore('updates').add(h.Y.encodeStateAsUpdate(peer));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    const invalidated=await h.cache.readDocumentPreview(state,id);tracker.dispose();await persistence.destroy();document.destroy();peer.destroy();
    return {text:cached.value?.snapshot.content[0].content[0].text,pending:cached.value?.pendingLocal,revision:cached.value?.metadata.revision,payloadReads,wrongOwner:wrongOwner.value,invalidated:invalidated.value,hasNewUpdate:invalidated.hasUpdates};
  });
  expect(result).toEqual({text:'尚未上传的本机草稿',pending:true,revision:4,payloadReads:0,wrongOwner:null,invalidated:null,hasNewUpdate:true});
});

test('worker compacts a large old IndexedDB state while retaining pending edits, anchors and recovery state',async({page},testInfo)=>{
  await page.goto('/');await installHarness(page);
  const result=await page.evaluate(async({script,name})=>{
    const h=(window as any).anotePreviewTest,document=h.prosemirrorJSONToYDoc(h.schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:'retained'},content:[{type:'text',text:'原始批注定位，未上传的本机正文'}]}]},'default'),anchor=h.findAnchor(document,'原始批注定位'),first=(document.getXmlFragment('default').get(0) as any)._item.id;
    const history=document.getMap('__tiptap_position_migrations:root:default');
    document.transact(()=>{for(let record=0;record<562;record++){const transfers=[];for(let index=0;index<286;index++){const clock=100000+record*286+index;transfers.push({source:{client:2147483645,clock:clock*2,length:1},target:{client:2147483644,clock:clock*3,type:{client:2147483644,clock:0},assoc:0}});}history.set('old:'+record,{version:1,client:2147483646,clock:record+1,seen:record?[[2147483646,record]]:[],transfers});}});
    document.getMap('local-pending').set('text','断网时的待同步修改');const before=h.Y.encodeStateAsUpdate(document);
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{request.result.createObjectStore('updates',{autoIncrement:true});request.result.createObjectStore('custom');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise<void>((resolve,reject)=>{const tx=database.transaction('updates','readwrite');tx.objectStore('updates').add(before);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    let ticks=0;const heartbeat=setInterval(()=>ticks++,2),url=URL.createObjectURL(new Blob([script],{type:'text/javascript'})),start=performance.now();
    const response:any=await new Promise((resolve,reject)=>{const worker=new Worker(url);worker.onmessage=event=>{worker.terminate();resolve(event.data);};worker.onerror=reject;worker.postMessage({database:name});});
    const elapsed=performance.now()-start;clearInterval(heartbeat);URL.revokeObjectURL(url);
    const saved:any=await new Promise((resolve,reject)=>{const tx=database.transaction(['updates','custom'],'readonly'),updates=tx.objectStore('updates').getAll(),recovery=tx.objectStore('custom').get(h.repair.DOCUMENT_REPAIR_RECOVERY);tx.oncomplete=()=>resolve({updates:updates.result,recovery:recovery.result});tx.onerror=()=>reject(tx.error);});
    const restored=new h.Y.Doc();for(const update of saved.updates)h.Y.applyUpdate(restored,update);
    const value={ok:response.ok,status:response.result?.status,beforeBytes:before.byteLength,afterBytes:saved.updates.reduce((sum:number,value:Uint8Array)=>sum+value.byteLength,0),updateCount:saved.updates.length,heartbeatTicks:ticks,workerElapsedMs:elapsed,pending:restored.getMap('local-pending').get('text'),anchor:h.resolveAnchor(restored,anchor),sameFirstIdentity:JSON.stringify((restored.getXmlFragment('default').get(0) as any)._item.id)===JSON.stringify(first),recoveryBytes:saved.recovery?.ystate.byteLength};
    database.close();document.destroy();restored.destroy();return value;
  },{script:workerScript,name:'preview-worker-'+randomUUID()});
  expect(result.ok).toBe(true);expect(result.status).toBe('repaired');expect(result.beforeBytes).toBeGreaterThan(16*1024*1024);expect(result.afterBytes).toBeLessThan(result.beforeBytes*.3);expect(result.updateCount).toBe(1);expect(result.heartbeatTicks).toBeGreaterThan(2);expect(result.pending).toBe('断网时的待同步修改');expect(result.anchor).toMatchObject({text:'原始批注定位',orphaned:false});expect(result.sameFirstIdentity).toBe(true);expect(result.recoveryBytes).toBeGreaterThan(16*1024*1024);
  await testInfo.attach('indexeddb-compaction.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});

test('compaction CAS includes a write from another tab instead of deleting it',async({page})=>{
  await page.goto('/');await installHarness(page);
  const result=await page.evaluate(async name=>{
    const h=(window as any).anotePreviewTest,document=new h.Y.Doc();document.getMap('draft').set('first','第一份草稿');
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{request.result.createObjectStore('updates',{autoIncrement:true});request.result.createObjectStore('custom');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise<void>((resolve,reject)=>{const tx=database.transaction('updates','readwrite');tx.objectStore('updates').add(h.Y.encodeStateAsUpdate(document));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    document.getMap('draft').set('late','另一标签页必须保留的修改');const late=h.Y.encodeStateAsUpdate(document),original=IDBDatabase.prototype.transaction,originalGetAll=IDBObjectStore.prototype.getAll,readTransactions=new WeakSet<IDBTransaction>();let injected=false;
    IDBObjectStore.prototype.getAll=function(...args:any[]){if(this.name==='updates')readTransactions.add(this.transaction);return (originalGetAll as any).apply(this,args);};
    IDBDatabase.prototype.transaction=function(stores:any,mode?:any,options?:any){const tx=original.call(this,stores,mode,options);if(this.name===name&&mode==='readonly'&&Array.isArray(stores)&&stores.includes('updates'))tx.addEventListener('complete',()=>{if(!readTransactions.has(tx)||injected)return;injected=true;original.call(database,'updates','readwrite').objectStore('updates').add(late);});return tx;};
    let repaired:any;try{repaired=await h.repair.repairDocumentDatabase(name);}finally{IDBDatabase.prototype.transaction=original;IDBObjectStore.prototype.getAll=originalGetAll;}
    const updates:any[]=await new Promise((resolve,reject)=>{const tx=database.transaction('updates','readonly'),request=tx.objectStore('updates').getAll();tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);});
    const restored=new h.Y.Doc();for(const update of updates)h.Y.applyUpdate(restored,update);const value={injected,status:repaired.status,first:restored.getMap('draft').get('first'),late:restored.getMap('draft').get('late')};database.close();document.destroy();restored.destroy();return value;
  },'preview-cas-'+randomUUID());
  expect(result).toEqual({injected:true,status:'repaired',first:'第一份草稿',late:'另一标签页必须保留的修改'});
});

test('continued CAS conflicts keep every original update and leave repair for a later open',async({page})=>{
  await page.goto('/');await installHarness(page);
  const result=await page.evaluate(async name=>{
    const h=(window as any).anotePreviewTest,document=new h.Y.Doc();document.getMap('draft').set('base','保留原始内容');
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{request.result.createObjectStore('updates',{autoIncrement:true});request.result.createObjectStore('custom');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise<void>((resolve,reject)=>{const tx=database.transaction('updates','readwrite');tx.objectStore('updates').add(h.Y.encodeStateAsUpdate(document));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    const original=IDBDatabase.prototype.transaction,originalGetAll=IDBObjectStore.prototype.getAll,readTransactions=new WeakSet<IDBTransaction>();let inserted=0;
    IDBObjectStore.prototype.getAll=function(...args:any[]){if(this.name==='updates')readTransactions.add(this.transaction);return (originalGetAll as any).apply(this,args);};
    IDBDatabase.prototype.transaction=function(stores:any,mode?:any,options?:any){const tx=original.call(this,stores,mode,options);if(this.name===name&&mode==='readonly'&&Array.isArray(stores)&&stores.includes('updates'))tx.addEventListener('complete',()=>{if(!readTransactions.has(tx))return;document.getMap('draft').set('tab-'+(++inserted),'竞争写入 '+inserted);original.call(database,'updates','readwrite').objectStore('updates').add(h.Y.encodeStateAsUpdate(document));});return tx;};
    let repaired:any;try{repaired=await h.repair.repairDocumentDatabase(name);}finally{IDBDatabase.prototype.transaction=original;IDBObjectStore.prototype.getAll=originalGetAll;}
    const saved:any=await new Promise((resolve,reject)=>{const tx=database.transaction(['updates','custom'],'readonly'),updates=tx.objectStore('updates').getAll(),recovery=tx.objectStore('custom').get(h.repair.DOCUMENT_REPAIR_RECOVERY);tx.oncomplete=()=>resolve({updates:updates.result,recovery:recovery.result});tx.onerror=()=>reject(tx.error);});
    const restored=new h.Y.Doc();for(const update of saved.updates)h.Y.applyUpdate(restored,update);const value={status:repaired.status,inserted,updates:saved.updates.length,base:restored.getMap('draft').get('base'),first:restored.getMap('draft').get('tab-1'),second:restored.getMap('draft').get('tab-2'),hasRecovery:!!saved.recovery};database.close();document.destroy();restored.destroy();return value;
  },'preview-cas-busy-'+randomUUID());
  expect(result).toEqual({status:'concurrent-update',inserted:2,updates:3,base:'保留原始内容',first:'竞争写入 1',second:'竞争写入 2',hasRecovery:false});
});

async function webPreviewState(page:Page){
  // Match Workspace's real web state (main.tsx); the web app deliberately has
  // no Electron bridge. Resolve the actual cookie-authenticated identity.
  return page.evaluate(async()=>{const response=await fetch('/api/auth/session');if(!response.ok)throw new Error('测试账号没有登录');const session=await response.json();return {serverURL:location.origin,user:session.user,workspace:''};});
}
async function cachePendingDraft(page:Page,id:string,text:string){
  await installHarness(page);
  const state=await webPreviewState(page);
  return page.evaluate(async({id,text,state})=>{
    const h=(window as any).anotePreviewTest,snapshot={type:'doc',content:[{type:'paragraph',attrs:{blockId:'pending-body'},content:[{type:'text',text}]}]},document=h.prosemirrorJSONToYDoc(h.schema,snapshot,'default'),persistence=new h.IndexeddbPersistence(h.cache.documentDatabaseName(state,id),document),tracker=h.trackDocumentPersistence(document,persistence);
    await persistence.whenSynced;await tracker.refresh();await h.cache.writeDocumentPreview(persistence,state,id,{id,title:'首屏独立预览',revision:1,access_revision:1,role:'editor'},snapshot,true);
    const result=!!(await h.cache.readDocumentPreview(state,id)).value;tracker.dispose();await persistence.destroy();document.destroy();return result;
  },{id,text,state});
}

test('a trusted pending local snapshot wins over an older server body on the first frame',async({page,request})=>{
  const {owner,note}=await fixture(request),draft='本机未同步草稿 '+randomUUID();await login(page,owner);expect(await cachePendingDraft(page,note.id,draft)).toBe(true);
  await page.addInitScript(()=>{(window as any).__previewTextLog=[];new MutationObserver(()=>{const text=document.querySelector('[data-testid="document-preview-body"]')?.textContent;if(text)(window as any).__previewTextLog.push(text);}).observe(document,{childList:true,subtree:true});});
  await page.routeWebSocket(/\/collab/,()=>{});await page.goto('/?scope=personal&doc='+note.id);
  await expect(page.getByTestId('editor')).toContainText(draft);
  const shown=await page.evaluate(()=>(window as any).__previewTextLog as string[]);expect(shown.length).toBeGreaterThan(0);expect(shown.every(text=>text.includes(draft))).toBe(true);await expect(page.getByTestId('editor')).not.toContainText('只读预览不能修改这个待办');
});

test('permission denial clears a trusted preview without showing the cached private body',async({page,request})=>{
  const {owner,note}=await fixture(request),draft='权限撤销后不可展示 '+randomUUID();await login(page,owner);expect(await cachePendingDraft(page,note.id,draft)).toBe(true);
  await page.addInitScript(text=>{(window as any).__privateBodyShown=false;new MutationObserver(()=>{if(document.querySelector('[data-testid="document-preview-body"]')?.textContent?.includes(text))(window as any).__privateBodyShown=true;}).observe(document,{childList:true,subtree:true});},draft);
  await page.route(`**/api/documents/${note.id}/preview`,route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'阅读权限已撤销'})}));
  await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('document-preview').getByRole('alert')).toContainText('阅读权限已撤销');await expect(page.getByTestId('document-preview-body')).toHaveCount(0);await expect(page.getByTestId('editor')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__privateBodyShown)).toBe(false);
  await installHarness(page);const state=await webPreviewState(page);await expect.poll(()=>page.evaluate(async({id,state})=>{const h=(window as any).anotePreviewTest,value=await h.cache.readDocumentPreview(state,id);return {preview:value.value,hasUpdates:value.hasUpdates};},{id:note.id,state})).toEqual({preview:null,hasUpdates:true});
});

test('authorized body is readable while collaboration is delayed and cannot change TODOs',async({page,request},testInfo)=>{
  const {owner,note}=await fixture(request);await login(page,owner);await page.routeWebSocket(/\/collab/,()=>{});
  let versions=0;const writes:string[]=[];page.on('request',request=>{if(request.url().includes(`/documents/${note.id}/versions`))versions++;if(request.method()!=='GET'&&request.url().includes(`/documents/${note.id}`))writes.push(request.method()+' '+new URL(request.url()).pathname);});
  await page.goto('/?scope=personal&doc='+note.id);
  const preview=page.getByTestId('document-preview');await expect(preview).toHaveAttribute('data-view-ready','true');await expect(preview).toContainText('轻量预览正文 '+note.id);await expect(preview).toHaveAttribute('data-edit-ready','false');await expect(page.getByTestId('document-preview-body')).toHaveAttribute('contenteditable','false');await expect(preview.locator('input[type="checkbox"]')).toBeDisabled();await expect(page.getByTestId('editor')).toHaveCount(0);await expect(preview.getByRole('region',{name:'参考笔记'})).toContainText('可读的参考笔记');
  await preview.locator('input[type="checkbox"]').evaluate(element=>{const input=element as HTMLInputElement;input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});await expect(preview.locator('input[type="checkbox"]')).not.toBeChecked();await page.keyboard.press('ControlOrMeta+s');
  await page.waitForTimeout(5200);expect(versions).toBe(0);expect(writes).toEqual([]);await testInfo.attach('readonly-preview.png',{body:await page.screenshot(),contentType:'image/png'});
});

test('a missing preview route falls back to freshly authorized old-server metadata',async({page,request})=>{
  const {owner,note}=await fixture(request);await login(page,owner);
  await page.route(`**/api/documents/${note.id}/preview`,route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({message:'Cannot GET preview'})}));
  await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('editor')).toContainText('轻量预览正文 '+note.id);await expect(page.getByTestId('document-preview')).toHaveCount(0);
});

test('old-server fallback treats metadata denial as denial and never opens an editor',async({page,request})=>{
  const {owner,note}=await fixture(request);await login(page,owner);
  await page.route(`**/api/documents/${note.id}/preview`,route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({message:'Cannot GET preview'})}));
  await page.route(`**/api/documents/${note.id}?content=metadata*`,route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({message:'笔记不存在'})}));
  await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('document-preview').getByRole('alert')).toContainText('笔记不存在');await expect(page.getByTestId('editor')).toHaveCount(0);await expect(page.getByTestId('document-preview-body')).toHaveCount(0);
});

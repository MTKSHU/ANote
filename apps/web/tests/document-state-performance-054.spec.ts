import {test,expect,type Page} from '@playwright/test';
import {Pool} from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import * as Y from 'yjs';
import {createDecoder,readVarString,readVarUint,readVarUint8Array} from 'lib0/decoding';
import {initProseMirrorDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {stable} from '@anote/sync-core';
import {historyHeavyTodo052} from '../../../validation/fixtures/history-heavy-todo-052';
import {api,admin,login} from './helpers';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const origin=process.env.BASE_URL||'http://anote.internal:3000',publicOrigin=process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3190';
const artifactDirectory=path.resolve(process.env.ANOTE_054_PERFORMANCE_ARTIFACTS||'artifacts/repair-054/browser-performance');
type Probe={bodyDetectedMs:number|null;viewReadyMs:number|null;firstBodyPaintMs:number|null;editReadyMs:number|null;syncReadyMs:number|null;viewSource:string|null;longTasks:{startMs:number;durationMs:number}[]};
type Wire={receivedMessageBytes:number[];sentMessageBytes:number[];receivedUpdateBytes:number[];sentUpdateBytes:number[];updates:Uint8Array[];decodeErrors:string[]};
const newWire=():Wire=>({receivedMessageBytes:[],sentMessageBytes:[],receivedUpdateBytes:[],sentUpdateBytes:[],updates:[],decodeErrors:[]});

async function installProbe(page:Page){
  await page.addInitScript(()=>{
    const probe:Probe={bodyDetectedMs:null,viewReadyMs:null,firstBodyPaintMs:null,editReadyMs:null,syncReadyMs:null,viewSource:null,longTasks:[]};(window as any).__anote054Performance=probe;
    const capture=()=>{
      const preview=document.querySelector('[data-testid="document-preview"][data-view-ready="true"]'),live=document.querySelector('.document-region[data-view-ready="true"]:not([aria-hidden="true"])');
      const body=document.querySelector<HTMLElement>('[data-testid="document-preview-body"],.document-region:not([aria-hidden="true"]) [data-testid="editor"]');
      if(body?.childElementCount&&body.getBoundingClientRect().width>0&&probe.bodyDetectedMs===null){probe.bodyDetectedMs=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{probe.firstBodyPaintMs=performance.now();}));}
      if((preview||live)&&probe.viewReadyMs===null){probe.viewReadyMs=performance.now();probe.viewSource=preview?'lightweight-preview':'live-document';}
      if(document.querySelector('.document-region[data-edit-ready="true"]:not([aria-hidden="true"])')&&probe.editReadyMs===null)probe.editReadyMs=performance.now();
      if(document.querySelector('.document-region[data-sync-ready="true"]:not([aria-hidden="true"])')&&probe.syncReadyMs===null)probe.syncReadyMs=performance.now();
    };
    new MutationObserver(capture).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-view-ready','data-edit-ready','data-sync-ready','aria-hidden']});
    try{new PerformanceObserver(list=>{for(const entry of list.getEntries())probe.longTasks.push({startMs:entry.startTime,durationMs:entry.duration});}).observe({entryTypes:['longtask']});}catch{}
  });
}
function recordWire(wire:Wire,id:string,direction:'received'|'sent',payload:Buffer|string){
  const bytes=typeof payload==='string'?Buffer.from(payload):payload;
  try{
    const decoder=createDecoder(bytes);if(readVarString(decoder)!==id)return;
    wire[direction==='received'?'receivedMessageBytes':'sentMessageBytes'].push(bytes.byteLength);
    if(readVarUint(decoder)!==0)return;const subtype=readVarUint(decoder);if(subtype!==1&&subtype!==2)return;
    const update=readVarUint8Array(decoder);wire[direction==='received'?'receivedUpdateBytes':'sentUpdateBytes'].push(update.byteLength);
    if(direction==='received')wire.updates.push(update);
  }catch(error){wire.decodeErrors.push((error as Error).message);}
}

test('QA054 actual browser first body, editable and synchronized timings before and after representation compaction',async({browser,request},testInfo)=>{
  test.setTimeout(360000);
  // Fail before authentication, SQL or mutation unless this is the explicitly
  // selected disposable QA deployment. Never infer this from a network alias.
  expect(process.env.ANOTE_ISOLATED_TESTS,'Explicit isolated QA authorization').toBe('1');
  expect(['http://127.0.0.1:3190','http://127.0.0.1:3200']).toContain(publicOrigin);
  expect(new URL(origin).hostname).toBe('anote.internal');
  expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe(publicOrigin);
  expect(process.env.DB_PASSWORD,'Isolated database password must be supplied').toBeTruthy();
  const owner=await admin(request);expect(owner.user.is_admin||owner.user.role==='admin').toBeTruthy();
  const suffix=randomUUID(),title='QA054 synthetic state performance '+suffix;
  const book=await api(request,'POST','spaces',{kind:'personal',name:'QA054 disposable performance '+suffix},owner),note=await api(request,'POST','documents',{space_id:book.id,title},owner);
  const sql=new Pool({host:'db',database:'anote',user:'anote',password:process.env.DB_PASSWORD,application_name:'anote-qa054-disposable-performance'}),fixture=historyHeavyTodo052(),snapshotHash=sha(stable(fixture.snapshot)),samples:any[]=[],maintenanceAttempts:any[]=[];
  const state=async()=>{
    const result=await sql.query('SELECT id,space_id,created_by,title,snapshot,revision,state_encoding,state_revision,access_revision,octet_length(ystate) AS state_bytes FROM documents WHERE id=$1 AND space_id=$2 AND created_by=$3 AND title=$4',[note.id,book.id,owner.user.id,title]);
    expect(result.rowCount,'Only the newly created QA note may be inspected').toBe(1);return result.rows[0];
  };
  const checkSnapshot=(value:any)=>expect(sha(stable(value))).toBe(snapshotHash);
  async function validateReadAPI(encoding:1|2){
    const before=await state(),preview=await api(request,'GET',`documents/${note.id}/preview`,undefined,owner),metadata=await api(request,'GET',`documents/${note.id}?content=metadata`,undefined,owner);
    expect(preview.id).toBe(note.id);expect(preview.created_by).toBe(owner.user.id);expect(preview.space_id).toBe(book.id);expect(preview.title).toBe(title);expect(preview.state_encoding).toBe(encoding);expect(metadata.state_encoding).toBe(encoding);
    expect(String(preview.state_revision)).toBe(String(before.state_revision));expect(String(metadata.state_revision)).toBe(String(before.state_revision));expect(String(preview.snapshot_revision)).toBe(String(before.revision));expect(String(preview.access_revision)).toBe(String(before.access_revision));expect(preview.hash).toBe(snapshotHash);
    expect(Object.hasOwn(preview,'ystate')).toBe(false);expect(Object.hasOwn(metadata,'ystate')).toBe(false);expect(Object.hasOwn(metadata,'snapshot')).toBe(false);expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(100000);checkSnapshot(preview.snapshot);checkSnapshot(before.snapshot);
    return {stateRevision:String(before.state_revision),contentRevision:String(before.revision),stateBytes:before.state_bytes,previewBytes:Buffer.byteLength(JSON.stringify(preview)),previewHash:preview.hash};
  }
  async function phase(encoding:1|2){
    const initial=await validateReadAPI(encoding);
    for(let repeat=0;repeat<2;repeat++){
      const context=await browser.newContext({viewport:{width:1580,height:1150}}),page=await context.newPage();
      try{
        await login(page);await installProbe(page);let wire=newWire(),responses:Promise<void>[]=[],reads:any[]=[];
        page.on('websocket',socket=>{socket.on('framereceived',event=>recordWire(wire,note.id,'received',event.payload));socket.on('framesent',event=>recordWire(wire,note.id,'sent',event.payload));});
        page.on('response',response=>{
          const url=new URL(response.url());if(url.pathname!==`/api/documents/${note.id}/preview`&&!(url.pathname===`/api/documents/${note.id}`&&url.searchParams.get('content')==='metadata'))return;
          const task=response.body().then(bytes=>{const value=JSON.parse(bytes.toString('utf8'));reads.push({route:url.pathname.endsWith('/preview')?'preview':'metadata',bytes:bytes.byteLength,status:response.status(),stateRevision:String(value.state_revision),revision:String(value.revision),encoding:value.state_encoding,hash:value.hash,hasYState:Object.hasOwn(value,'ystate'),snapshot:value.snapshot});});responses.push(task);
        });
        for(const cache of ['cold-indexeddb','warm-indexeddb-new-js'] as const){
          wire=newWire();responses=[];reads=[];
          if(cache==='cold-indexeddb')await page.goto(origin+'/?scope=personal&doc='+note.id);else await page.reload();
          await expect.poll(()=>page.evaluate(()=>(window as any).__anote054Performance?.syncReadyMs||0),{timeout:60000}).toBeGreaterThan(0);
          await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','true');
          await expect.poll(()=>page.evaluate(()=>(window as any).__anote054Performance?.firstBodyPaintMs||0),{timeout:15000}).toBeGreaterThan(0);
          const probe:Probe=await page.evaluate(()=>(window as any).__anote054Performance),body=await page.getByTestId('editor').evaluate(element=>(element as any).editor.getJSON());
          checkSnapshot(body);expect(probe.viewReadyMs).not.toBeNull();expect(probe.editReadyMs).not.toBeNull();expect(probe.syncReadyMs).not.toBeNull();expect(probe.viewReadyMs!).toBeLessThanOrEqual(probe.editReadyMs!);expect(probe.viewSource).toBe('lightweight-preview');
          await Promise.all(responses);expect(reads.some(value=>value.route==='preview')).toBe(true);expect(reads.some(value=>value.route==='metadata')).toBe(true);
          for(const read of reads){expect(read.status).toBe(200);expect(read.hasYState).toBe(false);expect(read.encoding).toBe(encoding);expect(Number(read.stateRevision)).toBeGreaterThanOrEqual(Number(initial.stateRevision));if(read.snapshot){checkSnapshot(read.snapshot);expect(read.hash).toBe(snapshotHash);expect(read.bytes).toBeLessThan(100000);}}
          expect(wire.decodeErrors).toEqual([]);
          const largestUpdate=Math.max(0,...wire.receivedUpdateBytes),largestMessage=Math.max(0,...wire.receivedMessageBytes);
          if(cache==='cold-indexeddb'){
            expect(largestUpdate).toBeGreaterThan(1000);if(encoding===1)expect(largestUpdate).toBeGreaterThan(fixture.update.byteLength*.95);else expect(largestUpdate).toBeLessThan(fixture.update.byteLength*.15);
            // Decode only after the measured browser phase, so the Node test
            // process does not parse 17 MiB while timing the browser thread.
            const received=new Y.Doc();try{for(const update of wire.updates)Y.applyUpdate(received,update);checkSnapshot(initProseMirrorDoc(received.getXmlFragment('default'),schema).doc.toJSON());}finally{received.destroy();}
          }
          const full=await api(request,'GET',`documents/${note.id}`,undefined,owner);checkSnapshot(full.snapshot);expect(full.hash).toBe(snapshotHash);expect(full.title).toBe(title);
          const sample={encoding,repeat,cache,...probe,previewResponses:reads.filter(value=>value.route==='preview').map(({snapshot,...value})=>value),metadataResponses:reads.filter(value=>value.route==='metadata').map(({snapshot,...value})=>value),receivedMessages:wire.receivedMessageBytes.length,receivedDecodedMessageBytes:wire.receivedMessageBytes.reduce((sum,value)=>sum+value,0),largestDecodedMessageBytes:largestMessage,receivedYUpdateBytes:wire.receivedUpdateBytes.reduce((sum,value)=>sum+value,0),largestDecodedYUpdateBytes:largestUpdate,sentDecodedMessageBytes:wire.sentMessageBytes.reduce((sum,value)=>sum+value,0),sentYUpdateBytes:wire.sentUpdateBytes.reduce((sum,value)=>sum+value,0),editorSnapshotHash:sha(stable(body)),fullAPISnapshotHash:full.hash,dbStateAfter:await state()};delete sample.dbStateAfter.snapshot;samples.push(sample);
          // The warm case retains IndexedDB, but creates a fresh JS session.
          // Explicit save primes its trusted preview and waits for server ACK.
          await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');
        }
      }finally{await page.close().catch(()=>{});await context.close();}
    }
    return initial;
  }
  try{
    await state();const injected=await sql.query('UPDATE documents SET ystate=$1,snapshot=$2,state_encoding=1 WHERE id=$3 AND space_id=$4 AND created_by=$5 AND title=$6 RETURNING state_revision',[Buffer.from(fixture.update),fixture.snapshot,note.id,book.id,owner.user.id,title]);expect(injected.rowCount).toBe(1);
    const legacy=await phase(1);expect(legacy.stateBytes).toBe(fixture.update.byteLength);
    let applied:any;
    for(let attempt=0;attempt<20;attempt++){
      const preview=await api(request,'POST',`documents/${note.id}/state-maintenance/preview`,{operation:'compact'},owner);expect(preview.operation).toBe('compact');expect(preview.sourceEncoding).toBe(1);expect(preview.targetEncoding).toBe(2);expect(typeof preview.sourceStateRevision).toBe('string');expect(preview.snapshotHash).toBe(snapshotHash);expect(preview.afterBytes).toBeLessThan(fixture.update.byteLength*.15);
      const response=await request.post(`/api/documents/${note.id}/state-maintenance/apply`,{headers:{Authorization:'Bearer '+owner.token},data:{operation:'compact',confirm:true,sourceStateRevision:preview.sourceStateRevision}});expect(response.status()).toBe(201);const result=await response.json();maintenanceAttempts.push({...result,attempt});
      if(result.applied){applied=result;break;}expect(result.reason).toBe('document-active');await new Promise(resolve=>setTimeout(resolve,300));
    }
    expect(applied?.applied,'Maintenance must actually apply through the source-state CAS').toBe(true);expect(applied.reason).toBe('compacted');expect(applied.afterBytes).toBeLessThan(fixture.update.byteLength*.15);
    const compact=await phase(2);expect(compact.stateBytes).toBeLessThan(fixture.update.byteLength*.15);checkSnapshot((await state()).snapshot);
    let historicalBaseline:any=null;try{const parsed=JSON.parse(await fs.readFile('artifacts/monitoring/2026-11-09/browser-summary.json','utf8'));historicalBaseline={source:'artifacts/monitoring/2026-11-09/browser-summary.json',recordedAt:parsed.recordedAt,groups:parsed.groups,note:'Historical synthetic QA measurements from a separate run. Different readiness definitions and runtime conditions; not a controlled same-run comparison or an M1 hardware claim.'};}catch{}
    const median=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);return sorted.length%2?sorted[Math.floor(sorted.length/2)]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};
    const report={recordedAt:new Date().toISOString(),scope:'QA054 isolated synthetic admin-owned note only; two fresh browser contexts per encoding, each followed by a warm IndexedDB reload. Static assets may be cached after login. WebSocket byte counts are actual browser-received decompressed messages/Yjs payloads, not compressed TCP bytes. No Mac/M1 timing claim.',publicOrigin,noteId:note.id,bookId:book.id,fixture:{...fixture.stats,snapshotHash},legacy,compact,maintenanceAttempts,groups:[1,2].flatMap(encoding=>['cold-indexeddb','warm-indexeddb-new-js'].map(cache=>{const group=samples.filter(sample=>sample.encoding===encoding&&sample.cache===cache);return {encoding,cache,runs:group.length,medianFirstBodyPaintMs:median(group.map(sample=>sample.firstBodyPaintMs)),medianViewReadyMs:median(group.map(sample=>sample.viewReadyMs)),medianEditReadyMs:median(group.map(sample=>sample.editReadyMs)),medianSyncReadyMs:median(group.map(sample=>sample.syncReadyMs)),medianLargestDecodedYUpdateBytes:median(group.map(sample=>sample.largestDecodedYUpdateBytes))};})),samples,historicalBaseline};
    await fs.mkdir(artifactDirectory,{recursive:true});await fs.writeFile(path.join(artifactDirectory,'document-state-performance-054.json'),JSON.stringify(report,null,2)+'\n');await testInfo.attach('document-state-performance-054.json',{body:JSON.stringify(report,null,2),contentType:'application/json'});
  }finally{fixture.document.destroy();await sql.end();}
});

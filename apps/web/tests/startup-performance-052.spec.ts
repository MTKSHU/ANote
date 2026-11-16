import {test,expect,request as playwrightRequest,type APIRequestContext} from '@playwright/test';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import * as Y from 'yjs';
import {EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {historyHeavyTodo052} from '../../../validation/fixtures/history-heavy-todo-052';
import {api,login} from './helpers';
import {person} from './mcp-helpers';

const output='artifacts/preview-052/web',sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function metadata(request:APIRequestContext,id:string,account:any,status=200){
  const started=performance.now(),response=await request.get(`/api/documents/${id}?content=metadata`,{headers:{Authorization:'Bearer '+account.token}});
  const elapsedMs=performance.now()-started,bytes=await response.body();expect(response.status(),bytes.toString()).toBe(status);
  return {value:JSON.parse(bytes.toString()),elapsedMs,responseBytes:bytes.length};
}

test('17MiB迁移历史的短TODO冷开仅取元信息并压缩同步，正文和历史不变，撤权缓存不泄露',async({page,request,browser},testInfo)=>{
  const platform=await request.get('/api/platform/public').then(response=>response.json());
  expect(platform.public_origin).toBe('http://127.0.0.1:3170');
  const owner=await person(request),viewer=await person(request),outsider=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'大历史首开验证'},owner),note={id:randomUUID(),title:'102项任务与17MiB迁移历史'};
  let initialSnapshot:any,stats:ReturnType<typeof historyHeavyTodo052>['stats'],targetText='';
  {
    const fixture=historyHeavyTodo052();stats=fixture.stats;targetText=fixture.targetText;
    try{
      const seeded=await api(request,'POST',`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(fixture.update).toString('base64'),create:{space_id:book.id,folder_id:null,title:note.title}},owner);
      initialSnapshot=seeded.snapshot;expect(initialSnapshot).toEqual(fixture.snapshot);
    }finally{fixture.document.destroy();}
  }
  expect(stats).toMatchObject({tasks:102,taskLists:21,rootBlocks:32,characters:6538,migrationRecords:562,migrationTransfers:160376});
  const sharing=await api(request,'GET',`documents/${note.id}/sharing`,undefined,owner);
  await api(request,'PATCH',`documents/${note.id}/sharing`,{visibility:'private',access_revision:sharing.access_revision,collaborators:[{user_id:viewer.user.id,role:'viewer'}]},owner);
  await api(request,'POST',`documents/${note.id}/sharing/links`,{},owner);
  const info=await metadata(request,note.id,owner);
  expect(info.value).toMatchObject({id:note.id,title:note.title,space_id:book.id,space_name:book.name,space_kind:'personal',role:'admin',can_manage:true,collaborator_count:1,external_link_count:1});
  for(const key of ['snapshot','ystate','hash'])expect(info.value).not.toHaveProperty(key);
  expect(info.responseBytes).toBeLessThan(4096);
  expect((await metadata(request,note.id,viewer)).value).toMatchObject({role:'viewer',can_manage:false});
  await metadata(request,note.id,outsider,403);
  const anonymous=await playwrightRequest.newContext({baseURL:process.env.BASE_URL||'http://anote.internal:3000'});
  try{expect((await anonymous.get(`/api/documents/${note.id}?content=metadata`)).status()).toBe(401);}finally{await anonymous.dispose();}

  await login(page,owner);
  expect(await page.evaluate(async id=>(await indexedDB.databases()).some(item=>item.name?.includes(id)),note.id)).toBe(false);
  await page.addInitScript(({id,tasks})=>{
    const state:any={metadata:[],socketOpenMs:null,websocketExtensions:'',documentMessageMs:null,postMessageMicrotaskMs:null,postMessageTaskMs:null,documentMessageBytes:0,readyDomMs:null,readyFrameMs:null,longTasks:[]};
    (window as any).__startup052=state;
    const NativeSocket=window.WebSocket;
    window.WebSocket=new Proxy(NativeSocket,{construct(Target,args){
      const socket=Reflect.construct(Target,args) as WebSocket;
      if(new URL(String(args[0]),location.href).pathname.startsWith('/collab')){
        socket.addEventListener('open',()=>{state.socketOpenMs=performance.now();state.websocketExtensions=socket.extensions;});
        socket.addEventListener('message',event=>{
          const bytes=event.data instanceof ArrayBuffer?event.data.byteLength:event.data instanceof Blob?event.data.size:0;
          if(bytes>16*1024*1024&&state.documentMessageMs===null){state.documentMessageMs=performance.now();state.documentMessageBytes=bytes;queueMicrotask(()=>{state.postMessageMicrotaskMs=performance.now();});setTimeout(()=>{state.postMessageTaskMs=performance.now();},0);}
        });
      }
      return socket;
    }});
    new PerformanceObserver(list=>{
      for(const value of list.getEntries()){
        const entry=value as PerformanceResourceTiming,url=new URL(entry.name);
        if(url.pathname===`/api/documents/${id}`&&url.searchParams.get('content')==='metadata')state.metadata.push({startMs:entry.startTime,requestStartMs:entry.requestStart,responseStartMs:entry.responseStart,responseEndMs:entry.responseEnd,transferBytes:entry.transferSize,bodyBytes:entry.decodedBodySize});
      }
    }).observe({type:'resource',buffered:true});
    if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{for(const entry of list.getEntries())state.longTasks.push({startMs:entry.startTime,durationMs:entry.duration});}).observe({type:'longtask',buffered:true});
    const observer=new MutationObserver(()=>{
      const editor=document.querySelector('[data-testid="editor"]');
      if(state.readyDomMs===null&&editor?.querySelectorAll('input[type="checkbox"]').length===tasks){state.readyDomMs=performance.now();requestAnimationFrame(()=>{state.readyFrameMs=performance.now();});observer.disconnect();}
    });
    observer.observe(document,{subtree:true,childList:true});
  },{id:note.id,tasks:stats.tasks});
  const reads:{metadata:boolean;ttfbMs:number;bytes:number}[]=[];
  const readJobs:Promise<void>[]=[];
  page.on('response',response=>{
    const url=new URL(response.url());if(url.pathname!==`/api/documents/${note.id}`||response.request().method()!=='GET')return;
    readJobs.push((async()=>{const timing=response.request().timing(),body=await response.body();reads.push({metadata:url.searchParams.get('content')==='metadata',ttfbMs:timing.responseStart-timing.requestStart,bytes:body.length});})());
  });
  const started=performance.now();await page.goto('/?scope=personal&doc='+note.id);
  const editor=page.getByTestId('editor');await expect(editor).toHaveAttribute('contenteditable','true');await expect(editor.locator('input[type="checkbox"]')).toHaveCount(102);
  const readyAt=performance.now();expect(await editor.evaluate(dom=>(dom as any).editor.getJSON())).toEqual(initialSnapshot);
  await Promise.all(readJobs);expect(reads.length).toBeGreaterThan(0);expect(reads.every(read=>read.metadata&&read.bytes<4096)).toBe(true);
  await page.waitForFunction(()=>(window as any).__startup052?.readyFrameMs!=null);
  const browserClock=await page.evaluate(()=>(window as any).__startup052),extension=browserClock.websocketExtensions;
  expect(browserClock.metadata.length).toBeGreaterThan(0);expect(browserClock.documentMessageMs).not.toBeNull();expect(browserClock.documentMessageBytes).toBeGreaterThan(16*1024*1024);
  expect(extension).toContain('permessage-deflate');expect(extension).toContain('server_no_context_takeover');expect(extension).toContain('client_no_context_takeover');
  const timing={scope:'Cold document IndexedDB after login over the isolated Docker HTTP alias; static assets may already be cached. Browser clock measures first full-document animation frame; Node observations remain separate. No CDP session or WebSocket payload observer is registered.',metadataProbeRequestMs:info.elapsedMs,metadataTtfbMs:browserClock.metadata[0].responseStartMs-browserClock.metadata[0].requestStartMs,metadataBytes:reads[0].bytes,websocketOpenToDocumentMs:browserClock.documentMessageMs-browserClock.socketOpenMs,websocketSynchronousHandlingMs:browserClock.postMessageMicrotaskMs-browserClock.documentMessageMs,websocketNextTaskMs:browserClock.postMessageTaskMs-browserClock.documentMessageMs,editorReadyMs:browserClock.readyFrameMs,nodeObservedEditorReadyMs:readyAt-started,websocketSyncDecodedBytes:browserClock.documentMessageBytes,readyAfterDocumentMessageMs:browserClock.readyFrameMs-browserClock.documentMessageMs,websocketExtensions:extension,browserClock};
  await fs.mkdir(output,{recursive:true});await fs.writeFile(output+'/startup-history-timing.json',JSON.stringify(timing,null,2)+'\n');await testInfo.attach('startup-phase-timing',{body:JSON.stringify(timing),contentType:'application/json'});
  await page.screenshot({path:output+'/startup-history-todo.png',animations:'disabled'});
  expect((await api(request,'GET',`documents/${note.id}`,undefined,owner)).snapshot).toEqual(initialSnapshot);
  await page.close();

  const context=await browser.newContext();
  try{
    const reader=await context.newPage();await login(reader,viewer);await reader.goto('/?doc='+note.id);
    const readonly=reader.getByTestId('editor');await expect(readonly).toHaveAttribute('contenteditable','false');await expect(readonly.locator('input[type="checkbox"]')).toHaveCount(102);await expect(readonly.getByRole('checkbox').first()).toBeDisabled();
    expect(await readonly.evaluate(dom=>(dom as any).editor.getJSON())).toEqual(initialSnapshot);
    expect(await reader.evaluate(async id=>(await indexedDB.databases()).some(item=>item.name?.includes(id)),note.id)).toBe(true);
    const current=await api(request,'GET',`documents/${note.id}/sharing`,undefined,owner);
    await api(request,'PATCH',`documents/${note.id}/sharing`,{visibility:'private',access_revision:current.access_revision,collaborators:[]},owner);
    await metadata(request,note.id,viewer,403);
    await reader.addInitScript(text=>{
      (window as any).__revokedBodyExposed=false;
      const inspect=()=>{if([...document.querySelectorAll('[data-testid="editor"]')].some(node=>node.textContent?.includes(text)))(window as any).__revokedBodyExposed=true;};
      new MutationObserver(inspect).observe(document,{subtree:true,childList:true,characterData:true});
    },targetText);
    const denied=reader.waitForResponse(response=>new URL(response.url()).pathname===`/api/documents/${note.id}`&&new URL(response.url()).searchParams.get('content')==='metadata'&&response.status()===403);
    await reader.reload();await denied;await expect(readonly).toHaveCount(0);
    expect(await reader.evaluate(()=>(window as any).__revokedBodyExposed)).toBe(false);
  }finally{await context.close();}
  const final=await api(request,'GET',`documents/${note.id}/offline`,undefined,owner),persisted=new Y.Doc();
  try{
    Y.applyUpdate(persisted,Buffer.from(final.ystate,'base64'));const history=persisted.getMap('__tiptap_position_migrations:root:default');
    expect(history.size).toBe(stats.migrationRecords);expect(sha([...history.entries()])).toBe(stats.historySha256);expect(final.snapshot).toEqual(initialSnapshot);
  }finally{persisted.destroy();}
  const evidence={recordedAt:new Date().toISOString(),fixture:stats,timing,metadataContainsNoBody:true,onlyMetadataHttpReadsDuringOpen:true,initialAndFinalSnapshotSha256:sha(initialSnapshot),snapshotUnchanged:true,migrationHistoryUnchanged:true,viewerReadOnly:true,outsiderDenied:true,revokedMetadataDenied:true,revokedCachedBodyNeverMounted:true};
  await fs.mkdir(output,{recursive:true});await fs.writeFile(output+'/startup-history-evidence.json',JSON.stringify(evidence,null,2)+'\n');await testInfo.attach('startup-history-evidence',{body:JSON.stringify(evidence),contentType:'application/json'});
  expect(timing.metadataTtfbMs).toBeGreaterThanOrEqual(0);expect(timing.metadataTtfbMs).toBeLessThan(1000);expect(timing.editorReadyMs).toBeLessThan(4000);
});

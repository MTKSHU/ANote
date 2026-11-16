import {expect,type APIRequestContext,type Page} from '@playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import * as Y from 'yjs';
import {EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {historyHeavyTodo052} from './history-heavy-todo-052';
import {api} from '../../apps/web/tests/helpers';
import {person} from '../../apps/web/tests/mcp-helpers';

export async function warmDocumentFixture(request:APIRequestContext){
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'返回笔记性能隔离验证'},owner),id=randomUUID(),title='大历史 TODO '+id.slice(0,8),control=await api(request,'POST','documents',{space_id:book.id,title:'切换对照 '+id.slice(0,8)},owner);
  const fixture=historyHeavyTodo052();
  try{await api(request,'POST',`documents/${id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(fixture.update).toString('base64'),create:{space_id:book.id,folder_id:null,title}},owner);}
  finally{fixture.document.destroy();}
  return {owner,book,id,title,control,stats:fixture.stats,targetBlockId:fixture.targetBlockId,targetText:fixture.targetText};
}
function warmDocumentProbe(id:string){
    const metrics={id,opens:0,largeMessages:0,longTasks:[] as {start:number;duration:number}[],samples:[] as any[]};(window as any).__warm053=metrics;
    const open=indexedDB.open.bind(indexedDB);indexedDB.open=((name:string,...args:any[])=>{if(name.includes(id))metrics.opens++;return (open as any)(name,...args);}) as any;
    const Socket=window.WebSocket;window.WebSocket=new Proxy(Socket,{construct(Target,args){const socket=Reflect.construct(Target,args);socket.addEventListener('message',(event:MessageEvent)=>{const size=event.data instanceof ArrayBuffer?event.data.byteLength:event.data instanceof Blob?event.data.size:0;if(size>16*1024*1024)metrics.largeMessages++;});return socket;}});
    if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{for(const entry of list.getEntries())metrics.longTasks.push({start:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});
}
export async function installWarmDocumentProbe(page:Page,id:string){
  await page.evaluate(warmDocumentProbe,id);
}
export async function initWarmDocumentProbe(page:Page,id:string){
  await page.addInitScript(warmDocumentProbe,id);
}
export async function documentGuid(page:Page){return page.getByTestId('editor').evaluate(element=>(element as any).editor.extensionManager.extensions.find((extension:any)=>extension.name==='collaboration').options.document.guid);}
export async function warmSwitches(page:Page,fixture:Awaited<ReturnType<typeof warmDocumentFixture>>,expectCache:boolean){
  const editor=page.getByTestId('editor'),firstGuid=await documentGuid(page),guids:string[]=[];
  for(let cycle=0;cycle<3;cycle++){
    await page.locator('.library-note-list .note-list-item').filter({hasText:fixture.control.title}).click();await expect(editor.locator('input[type="checkbox"]')).toHaveCount(0);await expect(editor).toBeVisible();
    await page.evaluate(({title,blockId})=>{
      const metrics=(window as any).__warm053;let started:number|null=null;
      const clicked=(event:Event)=>{if((event.target as Element).closest('.note-list-item')?.textContent?.includes(title)){started=performance.now();window.removeEventListener('click',clicked,true);}};
      window.addEventListener('click',clicked,true);
      const observer=new MutationObserver(()=>{if(started===null)return;const editor=document.querySelector('[data-testid="editor"]');if(editor?.querySelector(`p[data-block-id="${blockId}"]`)&&editor.querySelectorAll('input[type="checkbox"]').length===102){observer.disconnect();requestAnimationFrame(()=>metrics.samples.push({started,ready:performance.now(),elapsedMs:performance.now()-started!}));}});
      observer.observe(document,{subtree:true,childList:true});
    },{title:fixture.title,blockId:fixture.targetBlockId});
    await page.locator('.library-note-list .note-list-item').filter({hasText:fixture.title}).click();await expect(editor.locator('input[type="checkbox"]')).toHaveCount(102);
    await page.waitForFunction(count=>(window as any).__warm053.samples.length===count,cycle+1);guids.push(await documentGuid(page));
  }
  await page.waitForTimeout(100);
  const metrics=await page.evaluate(()=>(window as any).__warm053);
  const result={firstGuid,guids,indexedDbOpens:metrics.opens,largeSyncMessages:metrics.largeMessages,samples:metrics.samples,longTasks:metrics.longTasks.filter((task:any)=>metrics.samples.some((sample:any)=>task.start>=sample.started&&task.start<sample.ready))};
  if(expectCache){expect(result.guids).toEqual([firstGuid,firstGuid,firstGuid]);expect(result.indexedDbOpens).toBe(1);for(const sample of result.samples)expect(sample.elapsedMs).toBeLessThan(1000);}
  return result;
}
export async function verifyWarmBody(request:APIRequestContext,fixture:Awaited<ReturnType<typeof warmDocumentFixture>>,snapshot:any){
  const final=await api(request,'GET',`documents/${fixture.id}/offline`,undefined,fixture.owner);expect(final.snapshot).toEqual(snapshot);
  const document=new Y.Doc();try{Y.applyUpdate(document,Buffer.from(final.ystate,'base64'));const history=document.getMap('__tiptap_position_migrations:root:default');expect(history.size).toBe(fixture.stats.migrationRecords);expect(createHash('sha256').update(JSON.stringify([...history.entries()])).digest('hex')).toBe(fixture.stats.historySha256);}finally{document.destroy();}
}

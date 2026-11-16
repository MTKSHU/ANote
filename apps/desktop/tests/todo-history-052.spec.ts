import {test,expect,_electron,type ElectronApplication} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import * as Y from "yjs";
import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api} from "../../web/tests/helpers";
import {person} from "../../web/tests/mcp-helpers";
import {historyHeavyTodo052} from "../../../validation/fixtures/history-heavy-todo-052";

let app:ElectronApplication|undefined;
test.afterEach(async()=>{await app?.close().catch(()=>{});app=undefined;});
const sha=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex"),p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*.95))]||0;

test("17 MiB history with 102 TODOs: paused backspace, native payloads, offline and cold-start durability",async({request})=>{
  const origin=process.env.BASE_URL||"http://anote.internal:3000",label=process.env.TODO_RUN_LABEL||"candidate",version=process.env.TODO_VERSION||"0.5.2";
  expect(origin).toBe("http://anote.internal:3000");expect((await api(request,"GET","platform/public")).public_origin).toBe("http://127.0.0.1:3170");
  const directory=path.resolve("artifacts/preview-052/desktop","todo-"+label);await fs.mkdir(directory,{recursive:true});
  const owner=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"大历史小TODO诊断"},owner),noteId=randomUUID(),fixture=historyHeavyTodo052();
  try{await api(request,"POST",`documents/${noteId}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(fixture.update).toString("base64"),create:{space_id:book.id,title:"102 TODO with retained history",folder_id:null}},owner);}finally{fixture.document.destroy();(fixture as any).document=undefined;(fixture as any).update=undefined;}
  const executable=path.resolve(process.env.TODO_EXECUTABLE||"artifacts/preview-052/desktop/releases/ANote-linux-x64/ANote"),asar=path.join(path.dirname(executable),"resources/app.asar"),before=sha(await fs.readFile(asar)),profile=path.join(directory,"profile-"+randomUUID());
  if(process.env.TODO_EXPECTED_ASAR_SHA256)expect(before).toBe(process.env.TODO_EXPECTED_ASAR_SHA256);
  await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,"settings.json"),JSON.stringify({serverURL:origin}));
  const launch=async()=>{app=await _electron.launch({executablePath:executable,args:["--no-sandbox","--password-store=basic","--document="+noteId],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:"1"}});return app.firstWindow();};
  let page=await launch();expect(await app!.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}))).toEqual({packaged:true,version});
  const versions=await app!.evaluate(()=>process.versions);
  await app!.evaluate(({ipcMain})=>{
    const handlers=(ipcMain as any)._invokeHandlers,original=handlers.get("anote:offline-cache-document");if(!original)throw new Error("native cache handler missing");
    const metrics={active:0,calls:[] as any[],ticks:0,maxGap:0,last:performance.now(),timer:undefined as any};(globalThis as any).__todoNative=metrics;
    handlers.set("anote:offline-cache-document",async(event:unknown,input:any)=>{const call={ystateBytes:input.ystate?.length||0,started:performance.now(),elapsedMs:0};metrics.calls.push(call);metrics.active++;try{return await original(event,input);}finally{call.elapsedMs=performance.now()-call.started;metrics.active--;}});
  });
  await page.evaluate(()=>{const tasks:{start:number;duration:number}[]=[];(window as any).__todoInitialTasks=tasks;const observer=new PerformanceObserver(list=>list.getEntries().forEach(entry=>tasks.push({start:entry.startTime,duration:entry.duration})));observer.observe({entryTypes:["longtask"]});(window as any).__todoInitialObserver=observer;});
  const opened=Date.now();await page.getByRole("button",{name:"连接服务器",exact:true}).click();await page.getByLabel("服务地址",{exact:true}).fill(origin);await page.getByLabel("用户名",{exact:true}).fill(owner.username);await page.getByLabel("密码",{exact:true}).fill(owner.password);await page.getByRole("button",{name:"登录并连接",exact:true}).click();
  const editor=page.getByTestId("editor");await expect(editor).toBeVisible();await expect(editor.locator('input[type="checkbox"]')).toHaveCount(102);
  const editorVisibleIncludingLoginMs=Date.now()-opened;
  const update=page.getByRole("complementary",{name:"客户端版本更新",exact:true});if(await update.isVisible())await update.getByRole("button",{name:"稍后",exact:true}).click();
  await editor.evaluate((element,id)=>{const instance=(element as any).editor;let position=-1;instance.state.doc.descendants((node:any,pos:number)=>{if(node.attrs.blockId===id)position=pos+node.nodeSize-1;});if(position<0)throw new Error("target TODO block missing");instance.chain().setTextSelection(position).focus().run();},fixture.targetBlockId);
  const surface=editor.locator(`p[data-block-id="${fixture.targetBlockId}"]`);await expect(surface).toHaveText(fixture.targetText);
  await expect(editor).toBeFocused();
  // 0.5.1 can cache its initial empty editor before receiving the server body.
  // One visible normal edit plus the real Ctrl+S handler initializes that
  // renderer's full baseline; never call the bridge directly to fake an ACK.
  const warmedText=fixture.targetText+"x";
  await page.keyboard.type("x");await expect(surface).toHaveText(warmedText);
  await expect.poll(()=>editor.evaluate((element,id)=>{let text="";(element as any).editor.state.doc.descendants((node:any)=>{if(node.attrs.blockId===id)text=node.textContent;});return text;},fixture.targetBlockId)).toBe(warmedText);
  console.log(`todo-history ${label}: visible warmup committed to editor model`);
  await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存",{timeout:90000});
  await expect.poll(()=>app!.evaluate((_electron,bytes)=>{const metrics=(globalThis as any).__todoNative;return metrics.calls.some((call:any)=>call.ystateBytes>bytes&&call.elapsedMs>0)&&metrics.active===0;},fixture.stats.ystateBytes),{timeout:30000}).toBe(true).catch(async error=>{const metrics=await app!.evaluate(()=>(globalThis as any).__todoNative);await fs.writeFile(path.join(directory,"initial-cache-failure-diagnostic.json"),JSON.stringify({fixture:fixture.stats,native:metrics,editor:await editor.evaluate(element=>({focused:(element as any).editor.view.hasFocus(),editable:(element as any).editor.isEditable,characters:(element as any).editor.state.doc.textContent.length}))},null,2)+"\n");throw error;});
  const firstCacheAcknowledgedIncludingLoginMs=Date.now()-opened,initialCache=await app!.evaluate(()=>(globalThis as any).__todoNative.calls),initialRendererLongTasks=await page.evaluate(()=>{(window as any).__todoInitialObserver.disconnect();return(window as any).__todoInitialTasks;});
  console.log(`todo-history ${label}: full baseline ACK; measuring 24 keys`);
  await editor.evaluate(element=>{
    const metrics={raf:[] as number[],longTasks:[] as number[]};(window as any).__todoRenderer=metrics;
    const observer=new PerformanceObserver(list=>list.getEntries().forEach(entry=>metrics.longTasks.push(entry.duration)));observer.observe({entryTypes:["longtask"]});(window as any).__todoObserver=observer;
    element.addEventListener("keydown",event=>{if(event.key!=="Backspace")return;const started=performance.now();requestAnimationFrame(()=>metrics.raf.push(performance.now()-started));});
  });
  await app!.evaluate(()=>{const metrics=(globalThis as any).__todoNative;metrics.calls=[];metrics.last=performance.now();metrics.timer=setInterval(()=>{const now=performance.now();metrics.maxGap=Math.max(metrics.maxGap,now-metrics.last);metrics.last=now;metrics.ticks++;},5);});
  const presses:number[]=[];
  for(let index=0;index<24;index++){const start=Date.now();await page.keyboard.press("Backspace");presses.push(Date.now()-start);await page.waitForTimeout(550);if((index+1)%8===0)console.log(`todo-history ${label}: ${index+1} keys`);}
  await expect(surface).toHaveText(warmedText.slice(0,-24));await page.waitForTimeout(600);
  await expect.poll(()=>app!.evaluate(()=>(globalThis as any).__todoNative.active===0),{timeout:90000}).toBe(true);
  const native=await app!.evaluate(()=>{const metrics=(globalThis as any).__todoNative;clearInterval(metrics.timer);return {calls:metrics.calls,ticks:metrics.ticks,maxGapMs:metrics.maxGap};}),renderer=await page.evaluate(()=>{(window as any).__todoObserver.disconnect();return(window as any).__todoRenderer;});
  expect(renderer.raf).toHaveLength(24);expect(native.calls.length).toBeGreaterThan(1);
  if(version!=="0.5.1")expect(Math.max(...native.calls.map((call:any)=>call.ystateBytes))).toBeLessThan(16384);
  const finalSnapshot=await editor.evaluate(element=>(element as any).editor.getJSON()),bodyHash=sha(JSON.stringify(finalSnapshot));
  await page.keyboard.press("ControlOrMeta+s");await expect.poll(async()=>sha(JSON.stringify((await api(request,"GET",`documents/${noteId}`,undefined,owner)).snapshot)),{timeout:60000}).toBe(bodyHash);
  await page.evaluate(()=>window.anote.offline(true));const offline=await page.evaluate(async id=>fetch('/api/documents/'+id).then(response=>response.json()),noteId);expect(sha(JSON.stringify(offline.snapshot))).toBe(bodyHash);
  await app!.close();app=undefined;
  let cached:Y.Doc|undefined=new Y.Doc(),cachedHistoryRecords=0,cachedHistorySha256="";
  try{Y.applyUpdate(cached,Buffer.from(offline.ystate,"base64"));const history=cached.getMap("__tiptap_position_migrations:root:default");cachedHistoryRecords=history.size;cachedHistorySha256=sha(JSON.stringify([...history.entries()]));expect(cachedHistoryRecords).toBe(fixture.stats.migrationRecords);expect(cachedHistorySha256).toBe(fixture.stats.historySha256);}finally{cached.destroy();cached=undefined;}
  page=await launch();await expect(page.getByTestId("editor").locator(`p[data-block-id="${fixture.targetBlockId}"]`)).toHaveText(warmedText.slice(0,-24));expect(sha(JSON.stringify(await page.getByTestId("editor").evaluate(element=>(element as any).editor.getJSON())))).toBe(bodyHash);await app!.close();app=undefined;
  expect(sha(await fs.readFile(asar))).toBe(before);
  await fs.writeFile(path.join(directory,"report.json"),JSON.stringify({recordedAt:new Date().toISOString(),label,version,asarSha256:before,versions:{electron:versions.electron,chrome:versions.chrome},scope:"Single Linux Docker run, 24 backspaces at 550ms intervals after one visible warmup character and the full history baseline native cache ACK; not macOS M1 acceptance.",fixture:fixture.stats,warmupCharacter:"x",editorVisibleIncludingLoginMs,firstCacheAcknowledgedIncludingLoginMs,initialCache,initialRendererLongTasks,presses:{p95Ms:p95(presses),maxMs:Math.max(...presses)},renderer:{p95FrameMs:p95(renderer.raf),maxFrameMs:Math.max(...renderer.raf),longTasks:renderer.longTasks},native,serverOfflineAndColdStartBodyHash:bodyHash,cachedHistoryRecords,cachedHistorySha256,bodyPreserved:true},null,2)+"\n");
});

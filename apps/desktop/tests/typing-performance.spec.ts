import {test,expect,_electron,type APIRequestContext,type ElectronApplication,type Page} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import * as Y from "yjs";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api} from "../../web/tests/helpers";
import {person} from "../../web/tests/mcp-helpers";

const runtime=process.env.PERFORMANCE_RUNTIME||"candidate",origin=process.env.BASE_URL||"http://anote.internal:3000";
const baseline=path.resolve("artifacts/releases/ANote-linux-x64/ANote"),directory=path.resolve("artifacts/preview-050/performance",runtime);
const executable=runtime==="baseline"?baseline:process.env.PERFORMANCE_EXECUTABLE?path.resolve(process.env.PERFORMANCE_EXECUTABLE):undefined;
const active:ElectronApplication[]=[];
test.afterEach(async()=>{for(const app of active.splice(0))await app.close().catch(()=>{});});
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const percentile=(values:number[],fraction:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))]||0;
function cpuSummary(profile:any){
  const nodes=new Map(profile.nodes.map((node:any)=>[node.id,node])),times=new Map<number,number>();let busy=0;
  for(let i=0;i<(profile.samples||[]).length;i++){const id=profile.samples[i],duration=(profile.timeDeltas?.[i]||0)/1000,node:any=nodes.get(id);times.set(id,(times.get(id)||0)+duration);if(node?.callFrame.functionName!=="(idle)")busy+=duration;}
  return {durationMs:(profile.endTime-profile.startTime)/1000,sampledBusyMs:busy,topSelfFrames:[...times].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([id,milliseconds])=>{const node:any=nodes.get(id);return {name:node?.callFrame.functionName||"anonymous",milliseconds,url:node?.callFrame.url,line:node?.callFrame.lineNumber,column:node?.callFrame.columnNumber};})};
}
async function runtimeBinding(){
  const files=executable?[path.join(path.dirname(executable),"resources/app.asar")]:[path.resolve("apps/desktop/dist/main.cjs"),path.resolve("apps/desktop/dist/preload.cjs"),path.resolve("apps/desktop/dist/web/index.html")];
  if(!executable){const html=await fs.readFile(files[2],"utf8");for(const match of html.matchAll(/(?:src|href)="\.\/(assets\/[^\"]+\.(?:js|css))"/g))files.push(path.resolve("apps/desktop/dist/web",match[1]));}
  return Promise.all(files.map(async file=>({file,sha256:digest(await fs.readFile(file))})));
}

async function fixture(request:APIRequestContext,kind:"ordinary"|"todo"){
  const account=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"Typing profile "+kind},account),note=await api(request,"POST","documents",{space_id:book.id,title:"Typing profile "+kind},account);
  const paragraph=(text:string)=>({type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text}]}),content:any[]=kind==="ordinary"?Array.from({length:24},(_,index)=>paragraph(`Ordinary paragraph ${index}. `+"Continuous ordinary text. ".repeat(3))):[{type:"taskList",content:Array.from({length:2000},(_,index)=>({type:"taskItem",attrs:{checked:false},content:[paragraph(`TODO ${index}: `+"Continuous todo entry. ".repeat(4))]}))}];
  content.push(paragraph("Typing surface: "));
  const document=prosemirrorJSONToYDoc(schema,{type:"doc",content},"default"),ystate=Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64");
  try{await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate},account);}finally{document.destroy();}
  return {account,book,note,ystate,sourceBytes:Buffer.byteLength(ystate),paragraphs:kind==="todo"?2001:25};
}

async function launch(profile:string,note:string){
  const app=await _electron.launch({...(executable?{executablePath:executable}:{}),args:["--no-sandbox","--password-store=basic",...(executable?[]:["apps/desktop"]),"--document="+note],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:"1"}});
  active.push(app);return {app,page:await app.firstWindow()};
}
async function close(app:ElectronApplication){await app.close();active.splice(active.indexOf(app),1);}
async function instrument(app:ElectronApplication,page:Page){
  await app.evaluate(({ipcMain,BrowserWindow})=>{
    const handlers=(ipcMain as any)._invokeHandlers,original=handlers?.get("anote:offline-cache-document");if(!original)throw new Error("Expected native cache IPC handler");
    const metrics={calls:0,bytes:0,maxBytes:0,oldBodyMetadataCalls:0,durations:[] as number[],stateNotifications:0,stateBytes:0};(globalThis as any).__typingMetrics=metrics;
    handlers.set("anote:offline-cache-document",async function(event:unknown,...args:unknown[]){const bytes=Buffer.byteLength(JSON.stringify(args)),metadata=(args[0] as any)?.metadata;if(metadata&&(metadata.ystate!==undefined||metadata.snapshot!==undefined||metadata.assets!==undefined))metrics.oldBodyMetadataCalls++;metrics.calls++;metrics.bytes+=bytes;metrics.maxBytes=Math.max(metrics.maxBytes,bytes);const start=performance.now();try{return await original(event,...args);}finally{metrics.durations.push(performance.now()-start);}});
    const window=BrowserWindow.getAllWindows()[0],send=window.webContents.send.bind(window.webContents);(window.webContents as any).send=(channel:string,...args:unknown[])=>{if(channel==="anote:state-changed"){metrics.stateNotifications++;metrics.stateBytes+=Buffer.byteLength(JSON.stringify(args));}return send(channel,...args);};
  });
  await page.evaluate(()=>{
    const metrics={raf:[] as number[],longTasks:[] as {start:number;duration:number}[],keys:0};(window as any).__typingMetrics=metrics;
    const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())metrics.longTasks.push({start:entry.startTime,duration:entry.duration});});observer.observe({entryTypes:["longtask"]});(window as any).__typingObserver=observer;
    document.addEventListener("keydown",event=>{if(event.key.length!==1||!(event.target as HTMLElement)?.isContentEditable)return;metrics.keys++;const start=performance.now();requestAnimationFrame(()=>metrics.raf.push(performance.now()-start));},true);
  });
}

test("compare actual desktop continuous typing, native payloads and cold-start durability",async({request},testInfo)=>{
  const startedAt=new Date().toISOString();
  expect(["baseline","candidate"]).toContain(runtime);expect(origin).toBe("http://anote.internal:3000");
  const platform=await api(request,"GET","platform/public");expect(platform.public_origin).toBe(process.env.PREVIEW_PUBLIC_ORIGIN||"http://127.0.0.1:3150");
  await fs.mkdir(directory,{recursive:true});const before=await runtimeBinding(),results=[];
  if(executable&&process.env.PERFORMANCE_EXPECTED_ASAR_SHA256)expect(before[0].sha256).toBe(process.env.PERFORMANCE_EXPECTED_ASAR_SHA256);
  for(const mode of ["server","personal"] as const)for(const kind of ["ordinary","todo"] as const){
    const label=mode+"-"+kind;console.log(`typing-profile ${runtime} ${label}: seed`);
    const f=await fixture(request,kind),profile=path.join(directory,label+"-"+randomUUID());await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,"settings.json"),JSON.stringify({serverURL:origin}));
    let noteId=f.note.id,client=await launch(profile,mode==="server"?noteId:""),page=client.page;const version=await client.app.evaluate(({app})=>app.getVersion());expect(version).toBe(runtime==="baseline"?"0.4.19":"0.5.0");expect(await client.app.evaluate(({app})=>app.isPackaged)).toBe(!!executable);console.log(`typing-profile ${runtime} ${label}: launched ${version}`);
    if(mode==="server"){
      await page.getByRole("button",{name:"连接服务器",exact:true}).click();await page.getByLabel("服务地址",{exact:true}).fill(origin);await page.getByLabel("用户名",{exact:true}).fill(f.account.username);await page.getByLabel("密码",{exact:true}).fill(f.account.password);await page.getByRole("button",{name:"登录并连接",exact:true}).click();
      await expect(page.getByTestId("editor")).toBeVisible();await page.evaluate(id=>window.anote.configureOffline!({enabled:true,scope:"selected",libraryIds:[id],includeAssets:false,backupIntervalMinutes:0}),f.book.id);
      await expect.poll(async()=>{const status=await page.evaluate(()=>window.anote.offlineStatus!());return status.complete&&!status.running;},{timeout:60000}).toBe(true);
    }else{
      const local=path.join(profile,"personal-notes");await fs.mkdir(local);await client.app.evaluate(({dialog},value)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[value]});},local);await page.getByRole("button",{name:"本地个人笔记",exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.anote.state().then(value=>!!value.personal))).toBe(true);
      noteId=await page.evaluate(async value=>{const headers={"Content-Type":"application/json"},space=await fetch("/api/spaces",{method:"POST",headers,body:JSON.stringify({kind:"personal",name:"Personal typing fixture"})}).then(response=>response.json()),note=await fetch("/api/documents",{method:"POST",headers,body:JSON.stringify({space_id:space.id,title:"Personal typing profile"})}).then(response=>response.json()),saved=await fetch(`/api/documents/${note.id}/local-state`,{method:"PUT",headers,body:JSON.stringify({ystate:value})});if(!saved.ok)throw new Error("Cannot seed local note: "+saved.status);return note.id;},f.ystate);await page.goto("anote://app/?doc="+noteId);await expect(page.getByTestId("editor")).toBeVisible();
    }
    await page.waitForTimeout(1000);const editor=page.getByTestId("editor"),last=editor.locator(":scope > p").last();await last.click();await page.keyboard.press("End");console.log(`typing-profile ${runtime} ${label}: capture`);
    await instrument(client.app,page);const cdp=await page.context().newCDPSession(page),localRequests:{bytes:number}[]=[];await cdp.send("Network.enable",{maxPostDataSize:20*1024*1024});cdp.on("Network.requestWillBeSent",event=>{if(event.request.method==="PUT"&&/\/local-state$/.test(event.request.url))localRequests.push({bytes:Buffer.byteLength(event.request.postData||"")});});await cdp.send("Profiler.enable");await cdp.send("Profiler.setSamplingInterval",{interval:1000});await cdp.send("Profiler.start");
    const marker="verified-continuous-typing-"+kind+"-abcdefghijklmnopqrstuvwxyz0123456789";const started=Date.now();await page.keyboard.type(marker,{delay:16});await page.waitForTimeout(1200);
    const cpu=await cdp.send("Profiler.stop"),elapsedMs=Date.now()-started;await cdp.detach();await fs.writeFile(path.join(directory,label+".cpuprofile"),JSON.stringify(cpu.profile));
    const renderer=await page.evaluate(()=>{(window as any).__typingObserver.disconnect();return (window as any).__typingMetrics;}),native=await client.app.evaluate(()=>(globalThis as any).__typingMetrics);
    expect(renderer.keys).toBe(marker.length);expect(renderer.raf.length).toBe(marker.length);if(mode==="server")expect(native.calls).toBeGreaterThan(0);else expect(localRequests.length).toBeGreaterThan(0);
    await page.keyboard.press("ControlOrMeta+s");await expect.poll(async()=>JSON.stringify(await page.evaluate(async id=>{const response=await fetch("/api/documents/"+id);return response.json();},noteId))).toContain(marker);
    await close(client.app);client=await launch(profile,noteId);page=client.page;await expect(page.getByTestId("editor")).toContainText(marker);await close(client.app);
    results.push({mode,kind,runtime,version,sourceBytes:f.sourceBytes,paragraphs:f.paragraphs,keys:renderer.keys,elapsedMs,cpu:cpuSummary(cpu.profile),raf:{p50:percentile(renderer.raf,.5),p95:percentile(renderer.raf,.95),max:Math.max(...renderer.raf)},longTasks:{count:renderer.longTasks.length,totalMs:renderer.longTasks.reduce((total:number,item:{duration:number})=>total+item.duration,0),maxMs:Math.max(0,...renderer.longTasks.map((item:{duration:number})=>item.duration))},native:{calls:native.calls,payloadBytes:native.bytes,maxPayloadBytes:native.maxBytes,oldBodyMetadataCalls:native.oldBodyMetadataCalls,p95Ms:percentile(native.durations,.95),stateNotifications:native.stateNotifications,stateBytes:native.stateBytes},local:{writes:localRequests.length,payloadBytes:localRequests.reduce((sum,item)=>sum+item.bytes,0)},coldStartContentPreserved:true,cpuProfile:label+".cpuprofile"});
    await fs.writeFile(path.join(directory,"partial-report.json"),JSON.stringify(results,null,2)+"\n");console.log(`typing-profile ${runtime} ${label}: durable`);
  }
  const after=await runtimeBinding();expect(after).toEqual(before);const report={runtime,packaged:!!executable,startedAt,finishedAt:new Date().toISOString(),platform:"Linux x64 Electron in Docker; same isolated API and fixture sizes; does not substitute for macOS M1 measurements",binding:{before,after},results};await fs.writeFile(path.join(directory,"report.json"),JSON.stringify(report,null,2)+"\n");await testInfo.attach("typing-performance",{body:Buffer.from(JSON.stringify(report,null,2)),contentType:"application/json"});
});

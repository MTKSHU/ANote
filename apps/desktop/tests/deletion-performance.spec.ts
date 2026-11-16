import {test,expect,_electron,type ElectronApplication} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import * as Y from "yjs";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api} from "../../web/tests/helpers";
import {person} from "../../web/tests/mcp-helpers";

const runtime=process.env.DELETION_RUNTIME||"candidate",origin=process.env.BASE_URL||"http://anote.internal:3000",directory=path.resolve("artifacts/preview-051/performance",process.env.DELETION_RUN_LABEL||runtime);
const executable=path.resolve(process.env.DELETION_EXECUTABLE|| (runtime==="baseline"?"artifacts/stable-050/desktop/releases/ANote-linux-x64/ANote":"artifacts/stable-051/desktop/releases/ANote-linux-x64/ANote"));
let app:ElectronApplication|undefined;
test.afterEach(async()=>{await app?.close().catch(()=>{});app=undefined;});
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex"),percentile=(values:number[],fraction:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))]||0;

test("actual packaged deletion bursts, periodic offline sync, background backup and cold-start durability",async({request})=>{
  expect(["baseline","candidate"]).toContain(runtime);expect(origin).toBe("http://anote.internal:3000");
  const manifest=await request.get("/api/platform/public").then(response=>response.json());expect(manifest.public_origin).toBe(process.env.PREVIEW_PUBLIC_ORIGIN);
  await fs.mkdir(directory,{recursive:true});const asar=path.join(path.dirname(executable),"resources/app.asar"),before=digest(await fs.readFile(asar)),results=[];
  if(process.env.DELETION_EXPECTED_ASAR_SHA256)expect(before).toBe(process.env.DELETION_EXPECTED_ASAR_SHA256);
  for(const kind of (process.env.DELETION_KINDS||"ordinary,todo").split(",") as ("ordinary"|"todo")[]){
    const account=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"Deletion performance "+kind},account),note=await api(request,"POST","documents",{space_id:book.id,title:"Deletion performance "+kind},account);
    const paragraph=(text:string)=>({type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text}]}),tail="Deletion surface: "+"abcdefghijklmno ".repeat(20),content=kind==="ordinary"?Array.from({length:24},(_,index)=>paragraph("Ordinary paragraph "+index+". "+"Plain content. ".repeat(10))):[{type:"taskList",attrs:{blockId:randomUUID()},content:Array.from({length:2000},(_,index)=>({type:"taskItem",attrs:{checked:false},content:[paragraph("TODO "+index+". "+"Continuous task text. ".repeat(12))]}))}];
    const document=prosemirrorJSONToYDoc(schema,{type:"doc",content:[...content,paragraph(tail)]},"default");
    try{await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64")},account);}finally{document.destroy();}
    const profile=path.join(directory,kind+"-"+randomUUID()),backups=path.join(profile,"backups");await fs.mkdir(backups,{recursive:true});await fs.writeFile(path.join(profile,"settings.json"),JSON.stringify({serverURL:origin}));
    app=await _electron.launch({executablePath:executable,args:["--no-sandbox","--password-store=basic","--document="+note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:"1"}});let page=await app.firstWindow();
    expect(await app.evaluate(({app})=>app.isPackaged)).toBe(true);expect(await app.evaluate(({app})=>app.getVersion())).toBe(runtime==="baseline"?"0.5.0":"0.5.1");
    await page.getByRole("button",{name:"连接服务器",exact:true}).click();await page.getByLabel("服务地址",{exact:true}).fill(origin);await page.getByLabel("用户名",{exact:true}).fill(account.username);await page.getByLabel("密码",{exact:true}).fill(account.password);await page.getByRole("button",{name:"登录并连接",exact:true}).click();
    await expect(page.getByTestId("editor")).toBeVisible();await page.evaluate(({id,backups})=>window.anote.configureOffline!({enabled:true,scope:"selected",libraryIds:[id],includeAssets:false,backupDirectory:backups,backupIntervalMinutes:0,retention:10}),{id:book.id,backups});
    await expect.poll(()=>page.evaluate(()=>window.anote.offlineStatus!().then(value=>value.complete&&!value.running)),{timeout:60000}).toBe(true);
    const update=page.getByRole("complementary",{name:"客户端版本更新",exact:true});if(await update.isVisible())await update.getByRole("button",{name:"稍后",exact:true}).click();
    const editor=page.getByTestId("editor");
    // Seeding a second independent Y.Doc can leave the server's original
    // empty paragraph after the fixture text. Target the exact text block,
    // rather than a visual line's End key or the document's last node.
    const initialSelection=await editor.evaluate((element,text)=>{const editor=(element as any).editor;let end=-1,blockId="";const nodes:{type:string;length:number}[]=[];editor.state.doc.forEach((node:any,pos:number)=>{nodes.push({type:node.type.name,length:node.textContent.length});if(node.type.name==="paragraph"&&node.textContent===text){end=pos+node.nodeSize-1;blockId=node.attrs.blockId;}});if(end<0||!blockId)throw new Error("Expected unique deletion surface");editor.chain().setTextSelection(end).focus().run();return {end,blockId,lastNodes:nodes.slice(-4)};},tail);
    await expect.poll(()=>editor.evaluate((element,end)=>{const editor=(element as any).editor;return editor.view.hasFocus()&&editor.state.selection.empty&&editor.state.selection.to===end;},initialSelection.end)).toBe(true);
    const surface=editor.locator(`:scope > p[data-block-id="${initialSelection.blockId}"]`);await expect(surface).toHaveText(tail);
    const fullReads:string[]=[];page.on("request",request=>{const url=new URL(request.url());if(request.method()==="GET"&&url.pathname==="/api/documents/"+note.id)fullReads.push(url.pathname);});
    await editor.evaluate(element=>{
      const metrics={walks:0,raf:[] as number[],longTasks:[] as number[],events:[] as any[]};(window as any).__deletionMetrics=metrics;
      const root=element,original=root.querySelectorAll.bind(root);root.querySelectorAll=function(selector:string){if(selector==='li[data-type="taskItem"] input[type="checkbox"]')metrics.walks++;return original(selector);} as typeof root.querySelectorAll;
      document.addEventListener("keydown",event=>{if(event.key!=="Backspace"||!(event.target as HTMLElement).isContentEditable)return;const start=performance.now(),editor=(root as any).editor,record={before:editor.state.selection.$from.parent.textContent.length,from:editor.state.selection.from,to:editor.state.selection.to,composing:editor.view.composing,after:0};metrics.events.push(record);requestAnimationFrame(()=>{metrics.raf.push(performance.now()-start);record.after=editor.state.selection.$from.parent.textContent.length;});},true);
      const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())metrics.longTasks.push(entry.duration);});observer.observe({entryTypes:["longtask"]});(window as any).__deletionObserver=observer;
    });
    if(process.env.DELETION_PROFILE_TYPING==="1"){
      const cpu=await page.context().newCDPSession(page);await cpu.send("Profiler.enable");await cpu.send("Profiler.setSamplingInterval",{interval:500});await cpu.send("Performance.enable");const phases=[];
      for(const phase of ["backspace16","typing16"]){
        const before=await cpu.send("Performance.getMetrics");await cpu.send("Profiler.start");
        if(phase==="backspace16")for(let index=0;index<16;index++){await page.keyboard.press("Backspace");await page.waitForTimeout(16);}
        else await page.keyboard.type("profileordinaryx",{delay:16});
        await page.waitForTimeout(100);const profile=await cpu.send("Profiler.stop"),after=await cpu.send("Performance.getMetrics");await fs.writeFile(path.join(directory,kind+"-"+phase+".cpuprofile"),JSON.stringify(profile.profile));
        const start=new Map(before.metrics.map(value=>[value.name,value.value]));phases.push({phase,metrics:Object.fromEntries(after.metrics.filter(value=>["ScriptDuration","LayoutDuration","RecalcStyleDuration","TaskDuration","JSHeapUsedSize"].includes(value.name)).map(value=>[value.name,value.value-(start.get(value.name)||0)]))});
      }
      await cpu.detach();await expect(surface).toHaveText(tail.slice(0,-16)+"profileordinaryx");await app.close();app=undefined;expect(digest(await fs.readFile(asar))).toBe(before);
      await fs.writeFile(path.join(directory,"typing-profile-metrics.json"),JSON.stringify({runtime,asarSha256:before,qualitativeProbeOnly:true,phases},null,2)+"\n");return;
    }
    for(let burst=0;burst<3;burst++){
      for(let index=0;index<16;index++){await page.keyboard.press("Backspace");await page.waitForTimeout(16);}
      await page.waitForTimeout(500);await page.evaluate(()=>window.anote.syncOffline!());await page.waitForTimeout(150);
    }
    const expected=tail.slice(0,-48);await fs.writeFile(path.join(directory,kind+"-input-diagnostic.json"),JSON.stringify({initialSelection,expected,received:await surface.textContent(),metrics:await page.evaluate(()=>(window as any).__deletionMetrics)},null,2)+"\n");await expect(surface).toHaveText(expected);expect(await surface.textContent()).toBe(expected);
    const metrics=await page.evaluate(()=>{(window as any).__deletionObserver.disconnect();return (window as any).__deletionMetrics;});expect(metrics.raf).toHaveLength(48);if(runtime==="candidate")expect(metrics.walks).toBe(0);
    const fullReadsDuringDeletion=fullReads.length;
    let bulkDelete:{tasks:number;toNextFrameMs:number;undoRestored:boolean}|undefined;
    if(kind==="todo"){
      const cpu=process.env.DELETION_PROFILE_BULK==="1"?await page.context().newCDPSession(page):undefined;
      if(cpu){await cpu.send("Profiler.enable");await cpu.send("Profiler.setSamplingInterval",{interval:500});await cpu.send("Profiler.start");}
      await editor.evaluate(element=>{const editor=(element as any).editor;let position=-1;editor.state.doc.forEach((node:any,pos:number)=>{if(node.type.name==="taskList")position=pos;});if(position<0)throw new Error("Expected task list for bulk deletion");editor.chain().setNodeSelection(position).focus().run();(window as any).__bulkDeleteFrame=null;document.addEventListener("keydown",()=>{const started=performance.now();requestAnimationFrame(()=>{(window as any).__bulkDeleteFrame=performance.now()-started;});},{once:true,capture:true});});
      await page.keyboard.press("Backspace");await expect(editor.locator('input[type="checkbox"]')).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).__bulkDeleteFrame)).not.toBeNull();
      if(cpu){const result=await cpu.send("Profiler.stop");await fs.writeFile(path.join(directory,"todo-bulk-delete.cpuprofile"),JSON.stringify(result.profile));await cpu.detach();}
      const toNextFrameMs=await page.evaluate(()=>(window as any).__bulkDeleteFrame);await page.keyboard.press("ControlOrMeta+z");await expect(editor.locator('input[type="checkbox"]')).toHaveCount(2000);await expect(surface).toHaveText(expected);
      bulkDelete={tasks:2000,toNextFrameMs,undoRestored:true};
    }
    await page.keyboard.press("ControlOrMeta+s");await page.evaluate(()=>window.anote.syncOffline!());await expect.poll(()=>page.evaluate(()=>window.anote.offlineStatus!().then(value=>value.pending))).toBe(0);
    await app.evaluate(()=>{const metrics={ticks:0,maxGapMs:0,last:performance.now()},timer=setInterval(()=>{const now=performance.now();metrics.maxGapMs=Math.max(metrics.maxGapMs,now-metrics.last);metrics.last=now;metrics.ticks++;},5);(globalThis as any).__backupHeartbeat={metrics,timer};});
    const started=Date.now(),first=await page.evaluate(()=>window.anote.createBackup!());const elapsedMs=Date.now()-started;
    const heartbeat=await app.evaluate(()=>{const value=(globalThis as any).__backupHeartbeat;clearInterval(value.timer);return value.metrics;});
    const second=await page.evaluate(()=>window.anote.createBackup!());expect(second.skipped).toBe(true);expect(second.addedBytes).toBe(0);expect((await page.evaluate(()=>window.anote.listBackups!())).length).toBe(1);
    await app.close();app=undefined;
    app=await _electron.launch({executablePath:executable,args:["--no-sandbox","--password-store=basic","--document="+note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:"1"}});page=await app.firstWindow();await expect(page.getByTestId("editor").locator(`:scope > p[data-block-id="${initialSelection.blockId}"]`)).toHaveText(expected);await app.close();app=undefined;
    results.push({kind,keys:48,fullDocumentReadsAfterReady:fullReadsDuringDeletion,fullTaskDomWalks:metrics.walks,raf:{p50:percentile(metrics.raf,.5),p95:percentile(metrics.raf,.95),max:Math.max(...metrics.raf)},longTasks:{count:metrics.longTasks.length,totalMs:metrics.longTasks.reduce((sum:number,value:number)=>sum+value,0),maxMs:Math.max(0,...metrics.longTasks)},...(bulkDelete?{bulkDelete}:{}),backup:{elapsedMs,mainThreadTicks:heartbeat.ticks,maxMainThreadGapMs:heartbeat.maxGapMs,firstAddedBytes:first.addedBytes,unchangedAddedBytes:second.addedBytes},coldStartDeletionPreserved:true});
  }
  expect(digest(await fs.readFile(asar))).toBe(before);
  await fs.writeFile(path.join(directory,"report.json"),JSON.stringify({runtime,recordedAt:new Date().toISOString(),executable,asarSha256:before,scope:"One Linux Docker run per packaged runtime, same isolated API. Does not substitute for macOS M1 measurements.",results},null,2)+"\n");
});

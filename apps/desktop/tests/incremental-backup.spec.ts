import {test,expect,_electron,type ElectronApplication,type Page,type APIRequestContext} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api,openWorkspaceSettings} from "../../web/tests/helpers";
import {person} from "../../web/tests/mcp-helpers";
import {BackupRepository} from "../main/incremental-backups.mjs";

const origin=process.env.BASE_URL||"http://anote.internal:3000",executable=process.env.DESKTOP_EXECUTABLE;
const artifactRoot=process.env.ANOTE_TEST_ARTIFACT_ROOT||"artifacts/desktop";
const hash=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
const active:ElectronApplication[]=[];
test.afterEach(async()=>{for(const app of active.splice(0))await app.close().catch(()=>{});});

async function seed(request:APIRequestContext,account:any,book:any,title:string,body:string,attachment?:Buffer){
  const note=await api(request,"POST","documents",{space_id:book.id,title},account);let asset:any;
  if(attachment){
    const upload=await api(request,"POST","uploads",{space_id:book.id,doc_id:note.id,filename:"incremental-original.bin",bytes:attachment.length,hash:hash(attachment)},account);
    const sent=await request.put(`/api/uploads/${upload.id}/chunk`,{headers:{Authorization:"Bearer "+account.token,"Content-Type":"application/octet-stream","Upload-Offset":"0","X-Chunk-SHA256":hash(attachment)},data:attachment});expect(sent.ok(),await sent.text()).toBe(true);
    asset=await api(request,"POST",`uploads/${upload.id}/complete`,{},account);
  }
  const paragraph=(text?:string)=>({type:"paragraph",attrs:{blockId:randomUUID()},...(text?{content:[{type:"text",text}]}:{})});
  const content:any[]=[paragraph(body)];
  if(asset)content.push({type:"mediaResource",attrs:{blockId:randomUUID(),assetId:asset.id,src:asset.url,localPath:`assets/${asset.id}.bin`,title:asset.filename,kind:asset.kind,mime:asset.mime,bytes:asset.bytes,hash:asset.hash,projection:"flat"}},paragraph());
  const doc=prosemirrorJSONToYDoc(schema,{type:"doc",content},"default");
  try{await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")},account);}finally{doc.destroy();}
  return {note,asset};
}
async function launch(profile:string,noteId:string){
  const app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:["--no-sandbox","--password-store=basic",...(executable?[]:["apps/desktop"]),"--document="+noteId],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:"1"}});
  active.push(app);expect(await app.evaluate(({app})=>app.isPackaged)).toBe(!!executable);
  return {app,page:await app.firstWindow()};
}
async function close(app:ElectronApplication){await app.close();active.splice(active.indexOf(app),1);}
async function preferences(page:Page){await openWorkspaceSettings(page);const modal=page.getByRole("dialog",{name:"设置",exact:true});await modal.getByRole("button",{name:"离线与备份",exact:true}).click();await expect(modal.getByRole("button",{name:"立即备份",exact:true})).toBeEnabled();return modal;}
async function closePreferences(modal:ReturnType<Page["getByRole"]>){await modal.locator(":scope > header").getByRole("button",{name:"关闭",exact:true}).click();}
async function status(page:Page){return page.evaluate(()=>window.anote.offlineStatus!());}
async function list(page:Page){return page.evaluate(()=>window.anote.listBackups!());}
async function cached(page:Page,noteId:string){return page.evaluate(async id=>{const response=await fetch("/api/documents/"+id);if(!response.ok)throw new Error("Cached note read failed: "+response.status);return response.json();},noteId);}
async function attachmentDigest(page:Page,assetId:string){return page.evaluate(async id=>{const response=await fetch(`/api/assets/${id}/file`),bytes=await response.arrayBuffer();if(!response.ok)throw new Error("Cached attachment read failed: "+response.status);const digest=await crypto.subtle.digest("SHA-256",bytes);return {bytes:bytes.byteLength,sha256:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("")};},assetId);}
async function edit(page:Page,text:string){await expect(page.getByTestId("editor")).toBeVisible();await page.getByTestId("editor").locator(":scope > p").last().click();await page.keyboard.press("End");await page.keyboard.insertText(text);await page.keyboard.press("ControlOrMeta+s");}
async function size(root:string){let bytes=0,count=0;async function walk(directory:string){for(const item of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())await walk(file);else{expect(item.isFile()).toBe(true);bytes+=(await fs.stat(file)).size;count++;}}}await walk(root);return {bytes,count};}
async function manifest(root:string,id:string){return JSON.parse(await fs.readFile(path.join(root,id,"manifest.json"),"utf8"));}
async function runtimeFiles(){
  const files=executable?[path.join(path.dirname(path.resolve(executable)),"resources/app.asar")]:[path.resolve("apps/desktop/dist/main.cjs"),path.resolve("apps/desktop/dist/preload.cjs"),path.resolve("apps/desktop/dist/web/index.html")];
  if(!executable){const html=await fs.readFile(files[2],"utf8");for(const match of html.matchAll(/(?:src|href)="\.\/(assets\/(?:index-[^\"]+\.js|[^\"]+\.css))"/g))files.push(path.resolve("apps/desktop/dist/web",match[1]));}
  return Promise.all(files.map(async file=>{const bytes=await fs.readFile(file);return {file,bytes:bytes.length,sha256:hash(bytes)};}));
}

test("真实离线副本增量备份复用512KB附件与未改笔记，无变化不占新空间；恢复保留当前稿并在冷启动可读",async({request},testInfo)=>{
  expect(origin).toBe("http://anote.internal:3000");expect((await request.get("/api/platform/public").then(response=>response.json())).public_origin).toBe(process.env.PREVIEW_PUBLIC_ORIGIN||origin);
  const boundFiles=await runtimeFiles(),runtimeFile=boundFiles[0].file,runtimeBefore=boundFiles[0].sha256;
  const startedAt=new Date().toISOString(),account=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"增量备份真实验证"},account),binary=Buffer.concat([Buffer.from("ANote isolated incremental backup\0"),randomBytes(512*1024-34)]);
  const originalBody="备份时间点一的原始正文 "+randomUUID(),changedTail=" · 仅修改主稿的一次增量 "+randomUUID(),currentTail=" · 恢复前尚未备份的当前稿 "+randomUUID();
  const firstNote=await seed(request,account,book,"增量备份主稿",originalBody,binary),untouched=await seed(request,account,book,"保持不变的第二篇笔记","该正文与附件不应被重复复制 "+randomUUID());
  const root=path.resolve(artifactRoot,"incremental-backup-profiles",randomUUID()),profile=path.join(root,"profile"),backupDirectory=path.join(root,"backups");
  await fs.mkdir(profile,{recursive:true});await fs.mkdir(backupDirectory);await fs.writeFile(path.join(profile,"settings.json"),JSON.stringify({serverURL:origin}));
  const backupRoot=path.join(backupDirectory,"anote-backups-"+hash(Buffer.from(origin+"|"+account.user.id)).slice(0,16));
  let client=await launch(profile,firstNote.note.id),page=client.page;
  await page.getByRole("button",{name:"连接服务器",exact:true}).click();await page.getByLabel("服务地址",{exact:true}).fill(origin);await page.getByLabel("用户名",{exact:true}).fill(account.username);await page.getByLabel("密码",{exact:true}).fill(account.password);await page.getByRole("button",{name:"登录并连接",exact:true}).click();await expect(page.getByTestId("editor")).toContainText(originalBody);
  await page.evaluate(id=>window.anote.configureOffline!({enabled:true,scope:"selected",libraryIds:[id],includeAssets:true,backupIntervalMinutes:0}),book.id);
  await expect.poll(async()=>{const value=await status(page);return value.complete&&!value.running&&value.availableDocuments===2&&value.assets===1;},{timeout:60000}).toBe(true);
  await page.evaluate(()=>window.anote.offline(true));await expect.poll(()=>page.evaluate(()=>window.anote.state().then(value=>value.offline))).toBe(true);
  expect(await attachmentDigest(page,firstNote.asset.id)).toEqual({bytes:binary.length,sha256:hash(binary)});

  await client.app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},backupDirectory);
  let modal=await preferences(page);await modal.getByRole("button",{name:"选择目录",exact:true}).click();await expect(modal.getByLabel("备份目录",{exact:true})).toHaveValue(backupDirectory);await modal.getByLabel("自动备份间隔",{exact:true}).selectOption("0");
  await modal.getByRole("button",{name:"立即备份",exact:true}).click();await expect(modal.locator(".offline-controls-notice")).toContainText("增量备份已完成");await expect(modal.locator(".offline-controls-notice")).toContainText("本次新增");await expect(modal.getByRole("button",{name:"立即备份",exact:true})).toBeEnabled();
  const firstList=await list(page);expect(firstList).toHaveLength(1);const first=await manifest(backupRoot,firstList[0].id);expect(first.format).toBe("anote-chunked-backup");expect(first.version).toBe(3);expect(first.files.some((file:any)=>file.hash===hash(binary)&&file.bytes===binary.length)).toBe(true);
  const firstSize=await size(backupRoot),attachmentObject=path.join(backupRoot,"objects",hash(binary)),originalObject=await fs.stat(attachmentObject);expect(hash(await fs.readFile(attachmentObject))).toBe(hash(binary));

  await modal.getByRole("button",{name:"立即备份",exact:true}).click();await expect(modal.locator(".offline-controls-notice")).toContainText("内容没有变化");await expect(modal.locator(".offline-controls-notice")).toContainText("未新增备份文件");await expect(modal.getByRole("button",{name:"立即备份",exact:true})).toBeEnabled();
  expect((await list(page)).map(item=>item.id)).toEqual(firstList.map(item=>item.id));expect(await size(backupRoot)).toEqual(firstSize);

  await closePreferences(modal);await edit(page,changedTail);await expect.poll(async()=>JSON.stringify((await cached(page,firstNote.note.id)).snapshot)).toContain(changedTail);
  modal=await preferences(page);await modal.getByRole("button",{name:"立即备份",exact:true}).click();await expect(modal.locator(".offline-controls-notice")).toContainText("增量备份已完成");await expect(modal.locator(".offline-controls-notice")).toContainText("已复用");await expect(modal.getByRole("button",{name:"立即备份",exact:true})).toBeEnabled();
  const secondList=await list(page);expect(secondList).toHaveLength(2);const second=await manifest(backupRoot,secondList[0].id),secondSize=await size(backupRoot),reusedObject=await fs.stat(attachmentObject);
  expect(second.documents[untouched.note.id].hash).toBe(first.documents[untouched.note.id].hash);expect(second.documents[firstNote.note.id].hash).not.toBe(first.documents[firstNote.note.id].hash);expect(second.files).toEqual(first.files);expect(reusedObject.ino).toBe(originalObject.ino);expect(reusedObject.mtimeMs).toBe(originalObject.mtimeMs);expect(secondSize.bytes-firstSize.bytes).toBeGreaterThan(0);expect(secondSize.bytes-firstSize.bytes).toBeLessThan(binary.length/4);

  await closePreferences(modal);await edit(page,currentTail);await expect.poll(async()=>JSON.stringify((await cached(page,firstNote.note.id)).snapshot)).toContain(currentTail);
  modal=await preferences(page);await expect(modal.getByLabel("本地备份列表",{exact:true}).locator("article")).toHaveCount(2);await modal.getByLabel("本地备份列表",{exact:true}).locator("article").last().getByRole("button",{name:/^恢复备份：/}).click();
  const confirm=page.getByRole("dialog",{name:"恢复本地备份",exact:true});
  // Delay the actual selected manifest read, without replacing any backup
  // bytes or service responses, so the real restore lock can be observed.
  await client.app.evaluate((_electron,selected)=>{
    const filesystem=(process as any).getBuiltinModule("fs").promises,original=filesystem.readFile;let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    const gate={hits:0,release:()=>{filesystem.readFile=original;release();}};(globalThis as any).__incrementalRestoreGate=gate;
    filesystem.readFile=async function(file:unknown,...options:unknown[]){if(String(file)===selected){gate.hits++;await pending;}return original.call(this,file,...options);};
  },path.join(backupRoot,firstList[0].id,"manifest.json"));
  let loaded:Promise<unknown>|undefined;
  try{
    await confirm.getByRole("button",{name:"保留当前副本并恢复",exact:true}).click();
    await expect.poll(()=>client.app.evaluate(()=>(globalThis as any).__incrementalRestoreGate.hits)).toBeGreaterThan(0);
    expect((await page.evaluate(()=>window.anote.state())).backupRestoring).toBe(true);await expect(page.locator(".academic-workspace")).toHaveAttribute("inert","");await expect(page.getByRole("alertdialog",{name:"正在恢复本地备份",exact:true})).toBeVisible();
    const rejected=await page.evaluate(async id=>{const result=[];for(const action of [()=>window.anote.restoreBackup!(id),()=>window.anote.openLocalWorkspace!()]){try{await action();result.push("");}catch(error){result.push(error instanceof Error?error.message:String(error));}}return result;},firstList[0].id);expect(rejected).toHaveLength(2);for(const message of rejected)expect(message).toMatch(/正在|稍后/);
    loaded=page.waitForEvent("domcontentloaded");
  }finally{await client.app.evaluate(()=>(globalThis as any).__incrementalRestoreGate?.release()).catch(()=>{});}
  await loaded;await expect(page.getByTestId("editor")).toContainText(originalBody);await expect(page.getByTestId("editor")).not.toContainText(changedTail);await expect(page.getByTestId("editor")).not.toContainText(currentTail);await expect.poll(()=>page.evaluate(()=>window.anote.state().then(value=>!!value.backupRestoring))).toBe(false);await expect(page.locator(".academic-workspace")).not.toHaveAttribute("inert","");await expect(page.getByRole("alertdialog",{name:"正在恢复本地备份",exact:true})).toHaveCount(0);
  const preservedList=await list(page);expect(preservedList).toHaveLength(3);const repository=new BackupRepository(backupRoot,{identity:{serverURL:origin,userId:account.user.id},schema:EDITOR_SCHEMA_VERSION}),preservedRecord=(await repository.read(preservedList[0].id)).data.documents[firstNote.note.id];expect(JSON.stringify(preservedRecord.snapshot)).toContain(currentTail);expect(await attachmentDigest(page,firstNote.asset.id)).toEqual({bytes:binary.length,sha256:hash(binary)});
  await page.screenshot({path:path.join(root,"restored-incremental-backup.png"),fullPage:true});await close(client.app);client=await launch(profile,firstNote.note.id);page=client.page;await expect(page.getByTestId("editor")).toContainText(originalBody);await expect(page.getByTestId("editor")).not.toContainText(changedTail);expect((await page.evaluate(()=>window.anote.state())).offline).toBe(true);expect(await attachmentDigest(page,firstNote.asset.id)).toEqual({bytes:binary.length,sha256:hash(binary)});expect((await list(page)).map(item=>item.id)).toEqual(preservedList.map(item=>item.id));
  const checkedFiles=await runtimeFiles();expect(checkedFiles).toEqual(boundFiles);const runtimeAfter=checkedFiles[0].sha256;expect(runtimeAfter).toBe(runtimeBefore);
  const evidence={startedAt,finishedAt:new Date().toISOString(),packaged:!!executable,version:await client.app.evaluate(({app})=>app.getVersion()),runtime:{file:runtimeFile,before:runtimeBefore,after:runtimeAfter,filesBefore:boundFiles,filesAfter:checkedFiles,unchangedDuringRun:true},attachment:{bytes:binary.length,sha256:hash(binary)},first:{id:firstList[0].id,...firstSize},unchanged:{sameVersion:true,addedBytes:0},second:{id:secondList[0].id,...secondSize,addedBytes:secondSize.bytes-firstSize.bytes,untouchedRecordReused:true,attachmentObjectReused:true},restore:{target:firstList[0].id,preserved:preservedList[0].id,currentDraftRetained:true,attachmentRestored:true,slowReadBusyGuard:true,concurrentRestoreAndModeSwitchRejected:true,restartReadable:true},scope:"Actual Electron main/preload/renderer and isolated API; backup and restore executed through settings UI"};
  const file=path.join(artifactRoot,`${executable?"packaged-":""}incremental-backup-native-evidence.json`);await fs.writeFile(file,JSON.stringify(evidence,null,2)+"\n");await testInfo.attach("incremental-backup-evidence",{body:Buffer.from(JSON.stringify(evidence,null,2)),contentType:"application/json"});
});

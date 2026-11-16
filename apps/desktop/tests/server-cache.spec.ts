import {test,expect,_electron,type APIRequestContext,type Page} from "@playwright/test";
import fs from "node:fs/promises";
import {readFileSync} from "node:fs";
import path from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api, openWorkspaceSettings} from "../../web/tests/helpers";
import {person} from "../../web/tests/mcp-helpers";

const origin=process.env.BASE_URL||"http://anote.internal:3000",executable=process.env.DESKTOP_EXECUTABLE;
const bytes=readFileSync(path.resolve("artifacts/server/fixtures/sample.png"));
const sha=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
async function mediaNote(request:APIRequestContext,account:any,library:any,title:string,folder_id:string|null=null){
  const note=await api(request,"POST","documents",{space_id:library.id,folder_id,title},account);
  const upload=await api(request,"POST","uploads",{space_id:library.id,doc_id:note.id,filename:"cached.png",bytes:bytes.length,hash:sha(bytes)},account);
  const sent=await request.put(`/api/uploads/${upload.id}/chunk`,{headers:{Authorization:"Bearer "+account.token,"Content-Type":"application/octet-stream","Upload-Offset":"0","X-Chunk-Sha256":sha(bytes)},data:bytes});expect(sent.ok(),await sent.text()).toBeTruthy();
  const asset=await api(request,"POST",`uploads/${upload.id}/complete`,{},account);
  const value={type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text:title+" offline body"}]},{type:"mediaResource",attrs:{blockId:randomUUID(),assetId:asset.id,src:asset.url,localPath:`assets/${asset.id}.png`,title:"cached.png",kind:"image",mime:asset.mime,bytes:asset.bytes,hash:asset.hash,projection:"flat"}}]};
  const document=prosemirrorJSONToYDoc(schema,value,"default");
  try{await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64")},account);}finally{document.destroy();}
  return {note,asset};
}
async function preferences(page:Page){await openWorkspaceSettings(page);const modal=page.getByRole("dialog",{name:"设置",exact:true});await expect(modal).toBeVisible();return modal;}
async function local(page:Page,endpoint:string,headers:Record<string,string>={}){return page.evaluate(async({endpoint,headers})=>{const response=await fetch('/api/'+endpoint,{headers}),buffer=await response.arrayBuffer();return {status:response.status,cache:response.headers.get('X-ANote-Cache'),text:new TextDecoder().decode(buffer),bytes:Array.from(new Uint8Array(buffer))};},{endpoint,headers});}

test("服务器副本默认可选；持续保存新增笔记、冷启动目录和附件，并在撤权后阻止旧缓存读取",async({request})=>{
  expect(origin).toBe("http://anote.internal:3000");expect((await request.get('/api/platform/public').then(r=>r.json())).public_origin).toBe(origin);
  const reader=await person(request),other=await person(request),suffix=randomUUID().slice(0,8);
  const library=await api(request,"POST","spaces",{kind:"personal",name:"offline library "+suffix},reader),folder=await api(request,"POST",`spaces/${library.id}/folders`,{name:"cached folder "+suffix},reader);
  const own=await mediaNote(request,reader,library,"own media "+suffix,folder.id),foreign=await api(request,"POST","spaces",{kind:"personal",name:"PRIVATE library title "+suffix},other),shared=await mediaNote(request,other,foreign,"shared media "+suffix),hidden=await api(request,"POST","documents",{space_id:foreign.id,title:"NEVER CACHE "+suffix},other);
  const access=await api(request,"GET",`documents/${shared.note.id}/sharing`,undefined,other);
  await api(request,"PATCH",`documents/${shared.note.id}/sharing`,{visibility:"private",access_revision:access.access_revision,collaborators:[{user_id:reader.user.id,role:"viewer"}]},other);
  const root=path.resolve('artifacts/desktop/server-cache-profiles',randomUUID()),profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});
  let app:Awaited<ReturnType<typeof _electron.launch>>|undefined,page:Page;
  const errors:string[]=[];
  async function launch(id?:string){app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:['--no-sandbox',...(executable?[]:['apps/desktop']),...(id?['--document='+id]:[])],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:'0'},timeout:45000});page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await expect.poll(()=>page.evaluate(()=>!!window.anote)).toBe(true);}
  async function state(){return page.evaluate(()=>window.anote.offlineStatus!());}
  async function connect(){await page.evaluate(async input=>window.anote.connect(input),{serverURL:origin,username:reader.username,password:reader.password});await page.goto('anote://app/?doc='+own.note.id);await expect(page.getByTestId('editor')).toBeVisible();}
  try{
    await launch();await connect();
    const sidebar=page.locator('.academic-sidebar');await expect(sidebar.locator('.desktop-server-entry')).toHaveCount(0);
    for(const name of ['切换服务器','本地工作目录','本地个人笔记','在线同步','离线模式'])await expect(sidebar.getByRole('button',{name,exact:true})).toHaveCount(0);
    const before=await state();expect(before.config.enabled).toBe(false);
    let settings=await preferences(page);await expect(settings.getByRole('button',{name:'切换服务器',exact:true})).toBeVisible();await settings.getByRole('button',{name:'离线与备份',exact:true}).click();
    await settings.getByLabel('始终保留服务器笔记的本地副本',{exact:true}).check();
    await expect.poll(async()=>{const s=await state();return s.enabled&&s.complete&&s.assets>=2;},{timeout:90000}).toBe(true);
    const complete=await state();expect(complete.config.scope).toBe('all-readable');expect(complete.config.includeAssets).toBe(true);
    await settings.locator(':scope > header').getByRole('button',{name:'关闭',exact:true}).click();
    const cached=JSON.parse((await local(page,'documents')).text);expect(cached.some((n:any)=>n.id===hidden.id)).toBe(false);
    const fresh=await api(request,'POST','documents',{space_id:library.id,title:'new authenticated note '+suffix},reader);
    await page.goto('anote://app/?doc='+fresh.id);await expect(page.getByTestId('editor')).toBeVisible();
    await page.getByTestId('editor').locator('p').last().click();await page.keyboard.insertText('created after inventory '+suffix);await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(async()=>JSON.stringify((await api(request,'GET','documents/'+fresh.id,undefined,reader)).snapshot)).toContain('created after inventory '+suffix);
    await page.goto('anote://app/?doc='+own.note.id);await expect(page.getByTestId('editor')).toBeVisible();
    // This note is created outside the desktop. It must appear via maintenance,
    // without a manual download or opening it first.
    const later=await api(request,'POST','documents',{space_id:library.id,folder_id:folder.id,title:'background arrival '+suffix},reader);
    const recordFile=path.join(profile,'profiles',sha(Buffer.from(origin+'|'+reader.user.id)),'offline','documents',later.id+'.json');
    await expect.poll(async()=>{try{return JSON.parse(await fs.readFile(recordFile,'utf8')).metadata.id===later.id;}catch{return false;}},{timeout:100000}).toBe(true);
    // Check the replica itself, then reboot with a non-persisted Linux credential.
    await page.evaluate(()=>window.anote.offline(true));
    await expect.poll(async()=>JSON.parse((await local(page,'documents')).text).some((n:any)=>n.id===later.id)).toBe(true);
    await app!.close();app=undefined;await launch(own.note.id);await expect(page.getByTestId('editor')).toBeVisible();
    expect((await page.evaluate(()=>window.anote.state())).offline).toBe(true);
    const libraries=JSON.parse((await local(page,'spaces')).text);expect(libraries.some((l:any)=>l.id===library.id)).toBe(true);expect(libraries.some((l:any)=>l.name===foreign.name)).toBe(false);
    expect(JSON.parse((await local(page,`spaces/${library.id}/folders`)).text).some((f:any)=>f.id===folder.id)).toBe(true);
    expect(JSON.stringify(JSON.parse((await local(page,`spaces/${library.id}/catalog`)).text))).toContain(later.id);
    for(const asset of [own.asset,shared.asset]){const metadata=await local(page,`assets/${asset.id}`);expect(metadata.status).toBe(200);expect(JSON.parse(metadata.text).kind).toBe('image');const file=await local(page,`assets/${asset.id}/file`);expect(file.status).toBe(200);expect(sha(Buffer.from(file.bytes))).toBe(sha(bytes));const range=await local(page,`assets/${asset.id}/file`,{Range:'bytes=2-8'});expect(range.status).toBe(206);expect(Buffer.from(range.bytes)).toEqual(bytes.subarray(2,9));}
    await expect.poll(()=>page.locator('.media-resource img').first().evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
    await page.evaluate(id=>window.dispatchEvent(new CustomEvent('anote-preview-asset',{detail:id})),own.asset.id);
    await expect(page.getByRole('dialog',{name:'附件预览',exact:true})).toBeVisible();
    await page.screenshot({path:path.join(root,'offline-media-and-library.png')});
    await page.keyboard.press('Escape');
    await connect();
    const latest=await api(request,'GET',`documents/${shared.note.id}/sharing`,undefined,other);
    // A 0.4.14 HTTP-cache record must not bypass a known revocation after upgrade.
    const old=await api(request,'GET',`documents/${shared.note.id}`,undefined,reader),oldCache=path.join(profile,'http-cache',sha(Buffer.from(origin+'|'+reader.user.id+'|/api/documents/'+shared.note.id))+'.json');
    await fs.mkdir(path.dirname(oldCache),{recursive:true});await fs.writeFile(oldCache,JSON.stringify({type:'application/json',body:Buffer.from(JSON.stringify(old)).toString('base64'),at:new Date().toISOString()}));
    await api(request,'PATCH',`documents/${shared.note.id}/sharing`,{visibility:'private',access_revision:latest.access_revision,collaborators:[]},other);
    await page.evaluate(()=>window.anote.downloadOffline!());
    await page.evaluate(()=>window.anote.offline(true));
    for(const endpoint of [`documents/${shared.note.id}`,`documents/${shared.note.id}/info`,`assets/${shared.asset.id}`,`assets/${shared.asset.id}/file`])expect((await local(page,endpoint)).status,endpoint).toBe(403);
    const current=JSON.parse((await local(page,'documents')).text);expect(current.some((n:any)=>n.id===shared.note.id||n.id===hidden.id)).toBe(false);
    expect((await local(page,`assets/${own.asset.id}/file`)).status).toBe(200);expect(errors).toEqual([]);
  }finally{await app?.close().catch(()=>{});}
});

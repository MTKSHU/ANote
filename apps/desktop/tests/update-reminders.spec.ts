import {test,expect,_electron,type ElectronApplication,type Page} from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {randomUUID} from "node:crypto";
import * as Y from "yjs";
import {initProseMirrorDoc,updateYFragment} from "@tiptap/y-tiptap";
import {schema} from "@anote/document-model";
import {PersonalStore} from "../main/personal-store.mjs";

const executable=process.env.DESKTOP_EXECUTABLE,future="999.0.0";
type Seen={url:string;method:string;authorization?:string};
const applications:ElectronApplication[]=[],servers:http.Server[]=[];
test.afterEach(async()=>{
  for(const application of applications.splice(0))await application.close().catch(()=>{});
  for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

async function updateServer(initialStatus=0){
  const requests:Seen[]=[],state={checkStatus:initialStatus};
  const server=http.createServer((request,response)=>{
    requests.push({url:request.url!,method:request.method!,authorization:request.headers.authorization});
    response.setHeader("Cache-Control","no-store");response.setHeader("Content-Type","application/json");
    const url=new URL(request.url!,"http://isolated");
    if(url.pathname==="/api/client-releases/check"){
      if(state.checkStatus){response.writeHead(state.checkStatus).end(JSON.stringify({error:"isolated update metadata unavailable"}));return;}
      const platform=url.searchParams.get("platform"),arch=url.searchParams.get("arch"),file=`ANote-${future}-${platform}-${arch}.${platform==="win32"?"zip":"tar.gz"}`;
      response.end(JSON.stringify({version:future,editor_schema:8,signed:false,requires_auth:true,packages:[{platform,arch,file,bytes:1234,sha256:"a".repeat(64),url:"/api/client-releases/"+file}]}));return;
    }
    if(url.pathname==="/api/version"){response.end(JSON.stringify({desktop_version:future,editor_schema:8,build_id:null,web_entry:null}));return;}
    if(url.pathname==="/api/auth/providers"){response.end(JSON.stringify({local:true,casdoor:{enabled:false,start_url:null}}));return;}
    if(url.pathname.startsWith("/api/client-releases")){response.writeHead(401).end(JSON.stringify({error:"login required for binary downloads"}));return;}
    response.writeHead(404).end(JSON.stringify({error:"No business API exists in this isolated metadata fixture"}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));servers.push(server);
  const address=server.address();if(!address||typeof address==="string")throw new Error("No isolated fixture address");
  return {origin:`http://127.0.0.1:${address.port}`,requests,state};
}

async function personalProfile(origin:string){
  // Actual PersonalStore/Yjs files are prepared before Electron starts. The
  // tested main/preload/renderer and all update network requests remain real.
  const root=path.resolve("artifacts/desktop/update-reminder-profiles",randomUUID()),profile=path.join(root,"profile"),directory=path.join(root,"personal");
  await fs.mkdir(profile,{recursive:true});await fs.mkdir(directory,{recursive:true});
  const store=await new PersonalStore(directory).load();
  const api=async(endpoint:string,method="GET",data?:any)=>{
    const url=new URL("anote://app/api/"+endpoint),response=await store.respond(new Request(url,{method,...(data===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(data)})}),url);
    const value=await response.json();expect(response.ok,value.error||endpoint).toBe(true);return value;
  };
  const title="更新提醒中的私人笔记 "+randomUUID().slice(0,8),body="取消连接仍保留在本机的正文 "+randomUUID();
  let note:any,actor:string;
  try{
    const library=await api("spaces","POST",{kind:"personal",name:"Private local library"});note=await api("documents","POST",{space_id:library.id,title});
    const value=await api("documents/"+note.id),doc=new Y.Doc();
    try{
      Y.applyUpdate(doc,Buffer.from(value.ystate,"base64"));const fragment=doc.getXmlFragment("default"),{meta}=initProseMirrorDoc(fragment,schema);
      updateYFragment(doc,fragment,schema.nodeFromJSON({type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text:body}]}]}),meta);
      await api(`documents/${note.id}/local-state`,"PUT",{ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")});
    }finally{doc.destroy();}
    await store.mutate(()=>{store.index.lastDoc=note.id;});actor=store.state().user.id;
  }finally{await store.close();}
  await fs.writeFile(path.join(profile,"personal-mode.json"),JSON.stringify({directory}));
  // No account or credential exists. Keep the former manual offline flag to
  // reproduce the exact pre-0.4.16 silent-skip condition at startup.
  await fs.writeFile(path.join(profile,"settings.json"),JSON.stringify({serverURL:origin,user:null,offline:true,workspace:"",documents:[],lastDoc:null}));
  return {root,profile,directory,note,title,body,actor:actor!};
}
async function launch(fixture:Awaited<ReturnType<typeof personalProfile>>){
  const application=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:["--no-sandbox",...(executable?[]:["apps/desktop"]),"--document="+fixture.note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:fixture.profile,ANOTE_DESKTOP_TEST:"1"},timeout:30000});applications.push(application);
  const page=await application.firstWindow(),requests:Seen[]=[],errors:string[]=[];
  page.on("request",request=>requests.push({url:request.url(),method:request.method()}));page.on("pageerror",error=>errors.push(error.message));
  await expect(page.getByTestId("editor")).toContainText(fixture.body);await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(fixture.title);
  expect(await application.evaluate(({app})=>app.isPackaged)).toBe(!!executable);
  return {application,page,requests,errors};
}
const banner=(page:Page)=>page.getByRole("complementary",{name:"客户端版本更新",exact:true});
const notification=(page:Page)=>page.getByRole("region",{name:"通知列表",exact:true}).locator("article[data-client-update]");
async function saved(fixture:Awaited<ReturnType<typeof personalProfile>>){return JSON.parse(await fs.readFile(path.join(fixture.directory,".anote/notes",fixture.note.id+".json"),"utf8"));}
async function settings(page:Page){
  await page.locator(".workspace-account-menu > summary").click();await page.getByRole("menuitem",{name:"设置",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"设置",exact:true});await dialog.getByRole("button",{name:"客户端更新",exact:true}).click();return dialog;
}

test("无凭据的个人模式启动提醒；稍后仍在消息中心，连接后下载入口可取消且不触碰私人笔记",async({},testInfo)=>{
  const server=await updateServer(),fixture=await personalProfile(server.origin);let client=await launch(fixture);
  await expect(banner(client.page)).toContainText(future);
  const update=await client.page.evaluate(()=>window.anote.updateState!());expect(update.status).toBe("available");expect(update.needsAuth).toBe(true);expect(update.release?.file).toContain(future);
  const initial=await client.page.evaluate(()=>window.anote.state());expect(initial.personal).toBe(true);expect(initial.token).toBeNull();expect(initial.user?.id).toBe(fixture.actor);expect(initial.serverURL).not.toBe(server.origin);expect(initial.connectionServerURL).toBe(server.origin);
  expect(server.requests[0].url).toMatch(/^\/api\/client-releases\/check\?/);expect(server.requests.every(request=>!request.authorization)).toBe(true);
  // Even a direct Bridge invocation must reject an anonymous download, and
  // must use the configured server origin rather than the personal URI.
  const rejected=await client.page.evaluate(async()=>{try{await window.anote.downloadUpdate!();return "";}catch(error){return (error as Error).message;}});
  expect(rejected).toMatch(/连接并登录/);expect(server.requests.filter(request=>/^\/api\/client-releases\/ANote-/.test(request.url))).toHaveLength(0);
  await expect(banner(client.page)).toBeVisible();await banner(client.page).getByRole("button",{name:"稍后",exact:true}).click();await expect(banner(client.page)).toHaveCount(0);
  const finalTitle=fixture.title+" · 取消登录前",tail=" · 提醒弹出后仍能继续编辑";
  await client.page.getByLabel("笔记标题",{exact:true}).fill(finalTitle);await client.page.getByLabel("笔记标题",{exact:true}).press("Tab");
  await client.page.getByTestId("editor").locator(":scope > p").last().click();await client.page.keyboard.press("End");await client.page.keyboard.insertText(tail);
  await client.page.getByRole("link",{name:"消息通知",exact:true}).click();await expect(notification(client.page)).toContainText(future);
  await notification(client.page).getByRole("button",{name:"连接服务器后下载更新",exact:true}).click();
  const connect=client.page.getByRole("dialog",{name:"连接服务器",exact:true});await expect(connect).toBeVisible();await expect(connect.getByLabel("服务地址",{exact:true})).toHaveValue(server.origin);
  await connect.getByRole("button",{name:"关闭",exact:true}).click();await expect(connect).toHaveCount(0);await expect(notification(client.page)).toContainText(future);
  const retained=await client.page.evaluate(()=>window.anote.state());expect(retained.personal).toBe(true);expect(retained.user?.id).toBe(fixture.actor);expect(retained.workspace).toBe(fixture.directory);
  await expect.poll(async()=>JSON.stringify((await saved(fixture)).snapshot)).toContain(fixture.body+tail);
  expect(client.requests.filter(request=>/\/api\/(?:notifications|social\/badges|friends)(?:[/?]|$)/.test(request.url))).toEqual([]);
  expect(server.requests.filter(request=>request.method!=="GET")).toEqual([]);expect(server.requests.filter(request=>/^\/api\/client-releases\/ANote-/.test(request.url))).toEqual([]);expect(client.errors).toEqual([]);
  await client.application.close();applications.splice(applications.indexOf(client.application),1);
  client=await launch({...fixture,title:finalTitle,body:fixture.body+tail});await expect(banner(client.page)).toContainText(future);
  const catalog=JSON.parse(await fs.readFile(path.join(fixture.directory,".anote/catalog.json"),"utf8"));expect(catalog.documents.find((note:any)=>note.id===fixture.note.id).title).toBe(finalTitle);
  await client.page.screenshot({path:path.join(fixture.root,"native-update-reminder.png"),fullPage:true});
  await testInfo.attach("isolated-update-network",{body:Buffer.from(JSON.stringify({origin:server.origin,requests:server.requests,personalURI:initial.serverURL,downloadRejected:rejected,profile:fixture.profile},null,2)),contentType:"application/json"});
});

test("匿名旧服务器版本回退和检查失败仍可见，手动重试恢复且focus/online不破坏已知提醒",async({},testInfo)=>{
  const server=await updateServer(503),fixture=await personalProfile(server.origin),client=await launch(fixture);
  await expect.poll(()=>client.page.evaluate(()=>window.anote.updateState!().then(state=>state.status))).toBe("error");await expect(banner(client.page)).toHaveCount(0);
  const dialog=await settings(client.page),panel=dialog.getByRole("region",{name:"客户端更新",exact:true});await expect(panel.getByRole("alert")).toContainText("503");await expect(panel).toContainText("最近检查：尚未检查");
  server.state.checkStatus=401;await panel.getByRole("button",{name:"检查更新",exact:true}).click();
  await expect(banner(client.page)).toContainText(future);const available=await client.page.evaluate(()=>window.anote.updateState!());expect(available.status).toBe("available");expect(available.needsAuth).toBe(true);expect(available.release).toBeNull();
  await expect(panel).not.toContainText("最近检查：尚未检查");await expect(panel.getByRole("button",{name:"连接服务器后下载更新",exact:true})).toBeVisible();
  server.state.checkStatus=503;await panel.getByRole("button",{name:"检查更新",exact:true}).click();await expect(panel.getByRole("alert")).toContainText("503");await expect(banner(client.page)).toContainText(future);
  server.state.checkStatus=401;await panel.getByRole("button",{name:"检查更新",exact:true}).click();await expect.poll(()=>client.page.evaluate(()=>window.anote.updateState!().then(state=>state.status))).toBe("available");
  await client.page.evaluate(()=>window.dispatchEvent(new Event("online")));await client.application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].emit("focus"));
  const preserved=await client.page.evaluate(()=>window.anote.updateState!());expect(preserved.latestVersion).toBe(future);expect(preserved.needsAuth).toBe(true);
  expect(server.requests.some(request=>request.url==="/api/version")).toBe(true);expect(server.requests.every(request=>request.authorization===undefined)).toBe(true);expect(server.requests.filter(request=>/^\/api\/client-releases\/ANote-/.test(request.url))).toEqual([]);expect(client.errors).toEqual([]);
  expect(JSON.stringify((await saved(fixture)).snapshot)).toContain(fixture.body);
  await testInfo.attach("fallback-update-network",{body:Buffer.from(JSON.stringify({origin:server.origin,requests:server.requests,final:preserved},null,2)),contentType:"application/json"});
});

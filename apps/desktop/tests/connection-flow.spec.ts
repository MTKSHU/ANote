import {api,openWorkspaceSettings,openWorkspaceSwitcher,switchWorkspace} from "../../web/tests/helpers";
import {test,expect,_electron,type ElectronApplication,type Page,type Browser,type APIRequestContext} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";

const origin=process.env.BASE_URL||"http://anote.internal:3000",executable=process.env.DESKTOP_EXECUTABLE;
const active:ElectronApplication[]=[];
test.beforeEach(async({request})=>{
  expect(origin,"Connection tests require the isolated mock OIDC service").toBe("http://anote.internal:3000");
  const platform=await request.get("/api/platform/public").then(r=>r.json());expect(platform.public_origin).toBe(origin);
  const providers=await request.get("/api/auth/providers").then(r=>r.json());expect(providers.casdoor.enabled).toBe(true);expect(providers.casdoor.start_url).toBe(origin+"/api/auth/casdoor/start");
});
test.afterEach(async()=>{for(const app of active)await app.close().catch(()=>{});active.length=0;});

async function launch(profile:string,directory:string){
  const app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:executable?["--no-sandbox"]:["--no-sandbox","apps/desktop"],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:"0"}});active.push(app);
  await app.evaluate(({dialog,shell},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});shell.openExternal=async(url:string)=>{(globalThis as any).__connectionURL=url;};},directory);
  const info=await app.evaluate(({app})=>({packaged:app.isPackaged,name:app.getName(),appPath:app.getAppPath()}));expect(info.packaged).toBe(!!executable);expect(info.name).toBe("ANote");if(executable)expect(info.appPath).toContain("app.asar");
  return {app,page:await app.firstWindow(),info};
}
async function personalFixture(){
  const root=path.resolve("artifacts/desktop/connection-profiles",randomUUID()),directory=path.join(root,"personal"),profile=path.join(root,"profile");await fs.mkdir(directory,{recursive:true});
  const client=await launch(profile,directory),{page}=client;
  const entry=page.getByRole("button",{name:"连接服务器",exact:true});await expect(entry).toBeVisible();await expect(page.getByRole("button",{name:"本地个人笔记",exact:true})).toBeVisible();expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  await page.getByRole("button",{name:"本地个人笔记",exact:true}).click();await expect(page.locator(".academic-brand")).toHaveText("ANote");
  await page.locator(".academic-page-actions").getByRole("button",{name:"新建笔记",exact:true}).click();await expect(page.getByTestId("editor")).toBeVisible();
  const label="本地隔离记录 "+randomUUID(),body="原目录的私人正文 "+randomUUID();await page.getByLabel("笔记标题",{exact:true}).fill(label);await page.getByTestId("editor").locator(":scope > p").last().click();await page.keyboard.insertText(body);await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存到本地");
  const state=await page.evaluate(()=>window.anote.state()),note=new URL(page.url()).searchParams.get("doc")!;return {...client,root,directory,profile,label,body,state,note};
}
async function settings(page:Page){await openWorkspaceSettings(page);return page.getByRole("dialog",{name:"设置",exact:true});}
async function guide(page:Page){await switchWorkspace(page,"个人");const modal=page.getByRole("dialog",{name:"连接服务器",exact:true});await expect(modal).toBeVisible();await modal.getByLabel("服务地址",{exact:true}).fill(origin);await expect(modal.getByRole("button",{name:"使用 Casdoor 统一登录",exact:true})).toBeVisible();return modal;}
async function start(app:ElectronApplication,page:Page){await app.evaluate(()=>{(globalThis as any).__connectionURL=null;});await page.getByRole("button",{name:"使用 Casdoor 统一登录",exact:true}).click();await expect.poll(()=>app.evaluate(()=>(globalThis as any).__connectionURL)).toMatch(/^http:\/\/anote\.internal:3000\/api\/auth\/casdoor\/start\?ticket=/);return app.evaluate(()=>(globalThis as any).__connectionURL as string);}
async function follow(browser:Browser,url:string){const context=await browser.newContext();try{const page=await context.newPage();await page.goto(url);await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/callback\?/);}finally{await context.close();}}
async function provider(request:APIRequestContext,mode="normal"){const sub="connection-"+randomUUID();expect((await request.post("http://casdoor-mock:4400/control",{data:{sub,name:"桌面连接回归",preferred_username:"admin",mode}})).ok()).toBeTruthy();return sub;}
async function saved(directory:string,note:string){const catalog=JSON.parse(await fs.readFile(path.join(directory,".anote/catalog.json"),"utf8")),record=JSON.parse(await fs.readFile(path.join(directory,".anote/notes",note+".json"),"utf8"));return {catalog,record};}

test("个人模式取消或认证失败保留原目录；重启仍可查看原笔记",async({browser,request})=>{
  const client=await personalFixture(),{app,page,directory,state,note,body,label,profile}=client;
  await guide(page);await provider(request);await start(app,page);await page.getByRole("button",{name:"取消统一登录",exact:true}).click();await expect(page.getByRole("button",{name:"使用 Casdoor 统一登录",exact:true})).toBeEnabled();
  expect((await page.evaluate(()=>window.anote.state())).user?.id).toBe(state.user!.id);expect((await page.evaluate(()=>window.anote.state())).personal).toBe(true);
  await provider(request,"signature");const failing=await start(app,page);await follow(browser,failing);await expect(page.getByRole("alert")).toContainText(/未完成|过期|失败|重试/);
  const retained=await page.evaluate(()=>window.anote.state());expect(retained.personal).toBe(true);expect(retained.token).toBeNull();expect(retained.workspace).toBe(directory);
  const local=await saved(directory,note);expect(local.catalog.documents.find((n:any)=>n.id===note).title).toBe(label);expect(JSON.stringify(local.record.snapshot)).toContain(body);
  await app.close();active.splice(active.indexOf(app),1);
  // Model an actual pre-upgrade directory only after its client has released
  // the ordinary lock. The same source/ASAR application must migrate on boot.
  await fs.rename(path.join(directory,".anote"),path.join(directory,".simple-notes"));
  const reopened=await launch(profile,directory);await expect(reopened.page.getByLabel("笔记标题",{exact:true})).toHaveValue(label);await expect(reopened.page.getByTestId("editor")).toContainText(body);
  expect(await fs.stat(path.join(directory,".simple-notes")).catch(()=>null)).toBeNull();expect((await saved(directory,note)).catalog.id).toBe(state.user!.id);
});

test("个人模式经真实OIDC切换服务器，等待正文和标题保存；不自动上传且原目录可重入",async({browser,request})=>{
  const {app,page,directory,state,note,body,label}=await personalFixture(),finalTitle=label+" · 切换前标题",tail=" · 切换前尚未保存的正文";
  await page.evaluate(id=>{const original=window.fetch.bind(window);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});(window as any).__connectionSaveGate={count:0,release};window.fetch=async(input,options)=>{const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url,location.href),method=options?.method||(input instanceof Request?input.method:"GET");if((method==="PATCH"&&url.pathname==="/api/documents/"+id)||(method==="PUT"&&url.pathname==="/api/documents/"+id+"/local-state")){(window as any).__connectionSaveGate.count++;await gate;}return original(input,options);};},note);
  await page.getByLabel("笔记标题",{exact:true}).fill(finalTitle);await page.getByTestId("editor").locator(":scope > p").last().click();await page.keyboard.press("End");await page.keyboard.insertText(tail);
  await guide(page);await provider(request);const url=await start(app,page);await follow(browser,url);
  await expect.poll(()=>page.evaluate(()=>(window as any).__connectionSaveGate.count)).toBeGreaterThan(0);expect((await page.evaluate(()=>window.anote.state())).personal).toBe(true);await expect(page.locator(".academic-workspace")).toHaveAttribute("inert","");
  await page.evaluate(()=>(window as any).__connectionSaveGate.release());await expect.poll(()=>page.evaluate(()=>window.anote.state().then(s=>!!s.personal))).toBe(false);
  const connected=await page.evaluate(()=>window.anote.state());expect(connected.serverURL).toBe(origin);expect(connected.user?.id).not.toBe(state.user!.id);expect(connected.user?.is_admin).toBe(false);expect(connected.token).toMatch(/^[\w-]{43}$/);
  const remote=await request.get("/api/documents?q="+encodeURIComponent(label),{headers:{Authorization:"Bearer "+connected.token}});expect(remote.ok()).toBeTruthy();expect(await remote.json()).toEqual([]);
  const local=await saved(directory,note);expect(local.catalog.documents.find((n:any)=>n.id===note).title).toBe(finalTitle);expect(JSON.stringify(local.record.snapshot)).toContain(body+tail);
  const sidebar=page.getByRole("complementary",{name:"知识库侧边栏",exact:true});await expect(sidebar.locator(".desktop-server-entry,.native-sidebar-actions")).toHaveCount(0);await expect(sidebar.getByRole("button",{name:/本地工作目录|本地个人笔记|在线同步|离线模式|切换服务器/})).toHaveCount(0);
  const preferences=await settings(page);await expect(preferences.locator(".profile-status")).toHaveCount(0);await expect(preferences).not.toContainText("本地目录：尚未选择");await preferences.locator(":scope > header").getByRole("button",{name:"关闭",exact:true}).click();
  const serverTeam=await api(request,"POST","teams",{name:"切换本地后的服务器团队"},connected),serverBook=await api(request,"POST","spaces",{kind:"personal",name:"切换本地前的服务器知识库"},connected),serverNote=await api(request,"POST","documents",{space_id:serverBook.id,title:"服务器切换原稿"},connected),serverDraft="服务器未保存的原稿 "+randomUUID();
  await page.goto("anote://app/?doc="+serverNote.id);await expect(page.getByTestId("editor")).toBeVisible();await page.getByTestId("editor").locator(":scope > p").last().click();await page.keyboard.insertText(serverDraft);
  // This profile already remembers its local directory, so the menu returns
  // there directly and must save the pending server draft before switching.
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},directory);await switchWorkspace(page,"本地模式");await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(finalTitle);await expect(page.getByTestId("editor")).toContainText(body+tail);expect((await page.evaluate(()=>window.anote.state())).user?.id).toBe(state.user!.id);
  await expect.poll(async()=>JSON.stringify((await api(request,"GET",`documents/${serverNote.id}`,undefined,connected)).snapshot)).toContain(serverDraft);
  const resumeTail=" · 恢复服务器前尚未保存的本地正文";
  await page.evaluate(id=>{const original=window.fetch.bind(window);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});(window as any).__workspaceResumeGate={count:0,release};window.fetch=async(input,options)=>{const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url,location.href),method=options?.method||(input instanceof Request?input.method:"GET");if((method==="PATCH"&&url.pathname==="/api/documents/"+id)||(method==="PUT"&&url.pathname==="/api/documents/"+id+"/local-state")){(window as any).__workspaceResumeGate.count++;await gate;}return original(input,options);};},note);
  await page.getByTestId("editor").locator(":scope > p").last().click();await page.keyboard.press("End");await page.keyboard.insertText(resumeTail);
  const choices=await openWorkspaceSwitcher(page);await expect(choices.getByRole("menuitemradio",{name:serverTeam.name,exact:true})).toBeVisible();await expect(choices.getByRole("menuitemradio",{name:"本地模式",exact:true})).toHaveAttribute("aria-checked","true");
  await choices.getByRole("menuitemradio",{name:serverTeam.name,exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.anote.state().then(state=>state.workspaceSwitching))).toBe(true);
  await expect(page.locator(".academic-workspace")).toHaveAttribute("inert","");await expect.poll(()=>page.evaluate(()=>(window as any).__workspaceResumeGate.count)).toBeGreaterThan(0);
  const rejected=await page.evaluate(async()=>{try{await window.anote.openLocalWorkspace!();return null;}catch(error){return error instanceof Error?error.message:String(error);}});expect(rejected).toMatch(/正在切换/);
  await page.evaluate(()=>(window as any).__workspaceResumeGate.release());await expect(page.locator(".academic-page-header h1")).toHaveText(serverTeam.name);expect((await page.evaluate(()=>window.anote.state())).user?.id).toBe(connected.user!.id);
  await expect(page.getByRole("dialog",{name:"连接服务器",exact:true})).toHaveCount(0);expect(await request.get("/api/documents?q="+encodeURIComponent(label),{headers:{Authorization:"Bearer "+connected.token}}).then(response=>response.json())).toEqual([]);
  await switchWorkspace(page,"本地模式");await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(finalTitle);await expect(page.getByTestId("editor")).toContainText(body+tail+resumeTail);
  await page.screenshot({path:`artifacts/desktop/${executable?"packaged-":""}connection-personal-return.png`});
});

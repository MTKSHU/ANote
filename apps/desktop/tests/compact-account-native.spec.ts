import {test,expect,_electron,type ElectronApplication,type Page,type Browser,type APIRequestContext} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import {randomUUID} from "node:crypto";
import {api,openWorkspaceSwitcher,switchWorkspace,chooseTheme} from "../../web/tests/helpers";

const executable=process.env.DESKTOP_EXECUTABLE,origin=process.env.BASE_URL||"http://anote.internal:3000";
const applications:ElectronApplication[]=[],servers:http.Server[]=[];
test.afterEach(async({},info)=>{
  for(const app of applications.splice(0)){
    if(info.status!==info.expectedStatus)await app.firstWindow().then(page=>page.screenshot({path:info.outputPath("native-failure.png")})).catch(()=>{});
    await app.close().catch(()=>{});
  }
  for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
async function fixture(){
  const root=path.resolve("artifacts/desktop/compact-account-profiles",randomUUID()),profile=path.join(root,"profile"),directory=path.join(root,"personal");
  await fs.mkdir(profile,{recursive:true});await fs.mkdir(directory,{recursive:true});return {root,profile,directory};
}
async function launch(profile:string,directory:string){
  const app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:["--no-sandbox",...(executable?[]:["apps/desktop"])],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:"1"},timeout:45000});applications.push(app);
  await app.evaluate(({dialog,shell},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});shell.openExternal=async(url:string)=>{(globalThis as any).__compactAccountSSOURL=url;};},directory);
  const version=JSON.parse(await fs.readFile("apps/desktop/package.json","utf8")).version;
  expect(await app.evaluate(({app})=>({packaged:app.isPackaged,name:app.getName(),version:app.getVersion()}))).toEqual({packaged:!!executable,name:"ANote",version});
  return {app,page:await app.firstWindow(),version};
}
const tools=(page:Page)=>page.getByRole("group",{name:"用户与消息",exact:true});
const avatar=(page:Page)=>tools(page).getByRole("button",{name:"用户菜单",exact:true});
const account=(page:Page)=>page.getByRole("menu",{name:"用户菜单",exact:true});
async function noExtraHeaderRow(page:Page,document=false){
  await expect(page.locator(".academic-main")).toBeVisible();await expect(page.locator(".workspace-account-bar")).toHaveCount(0);
  const main=(await page.locator(".academic-main").boundingBox())!;expect(Math.abs(main.y)).toBeLessThanOrEqual(1);
  const box=(await tools(page).boundingBox())!;expect(box.width).toBeLessThanOrEqual(110);expect(box.height).toBeLessThanOrEqual(36);expect(box.y).toBe(16);
  const navigation=(await page.getByRole("button",{name:/^(收起|展开)侧边栏$/}).boundingBox())!;expect(navigation.x).toBe(16);expect(navigation.y).toBe(16);
  expect(box.x).toBeGreaterThanOrEqual(main.x);expect(box.x+box.width).toBeLessThanOrEqual(await page.evaluate(()=>innerWidth)+1);
  const heading=document?(await page.locator(".academic-document-header").boundingBox())!:null;
  if(heading){expect(Math.abs(heading.y)).toBeLessThanOrEqual(1);expect(box.y).toBeGreaterThanOrEqual(heading.y);expect(box.y+box.height).toBeLessThanOrEqual(heading.y+heading.height+1);}
  await test.info().attach("compact-header-geometry",{body:JSON.stringify({route:new URL(page.url()).search,main,tools:box,documentHeader:heading}),contentType:"application/json"});
}
async function follow(browser:Browser,url:string){
  const context=await browser.newContext();try{const page=await context.newPage();await page.goto(url);await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/callback\?/);}finally{await context.close();}
}
async function authenticatedNative(app:ElectronApplication,page:Page,browser:Browser,request:APIRequestContext){
  expect(origin).toBe("http://anote.internal:3000");const site=await request.get("/api/platform/public").then(response=>response.json());expect(site.public_origin).toBe(origin);
  const sub="compact-account-"+randomUUID(),email=sub+"@example.test",name="Alice Native";
  expect((await request.post("http://casdoor-mock:4400/control",{data:{sub,name,email,preferred_username:"compact-native",mode:"normal"}})).ok()).toBe(true);
  const connected=page.evaluate(serverURL=>window.anote.connectCasdoor({serverURL}),origin);
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).__compactAccountSSOURL as string)).toMatch(/^http:\/\/anote\.internal:3000\/api\/auth\/casdoor\/start\?ticket=/);
  await follow(browser,await app.evaluate(()=>(globalThis as any).__compactAccountSSOURL as string));const state=await connected;
  expect(state.user?.email).toBe(email);expect(state.token).toMatch(/^[\w-]{43}$/);return {state,email,name,token:state.token!};
}

test("真实服务器账号：工作空间二级菜单含本地、个人和全部团队，主菜单顺序正确且不增加顶部行",async({request,browser})=>{
  const files=await fixture(),{app,page}=await launch(files.profile,files.directory),owner=await authenticatedNative(app,page,browser,request);
  const teamA=await api(request,"POST","teams",{name:"Native A "+"较长研究团队名称".repeat(5)+randomUUID().slice(0,6)},owner),teamB=await api(request,"POST","teams",{name:"Native scope B "+randomUUID().slice(0,6)},owner);
  const library=await api(request,"POST","spaces",{kind:"team",team_id:teamA.id,name:"Native compact library"},owner),note=await api(request,"POST","documents",{space_id:library.id,title:"Native compact document"},owner);
  await page.goto("anote://app/");await expect(tools(page)).toBeVisible();await noExtraHeaderRow(page);
  await expect(avatar(page)).toHaveText("A");await expect(page.locator(".workspace-scope-menu")).toHaveCount(0);
  await avatar(page).click();await expect(account(page).locator(".workspace-account-identity strong")).toHaveText(owner.name);await expect(account(page).locator(".workspace-account-identity small")).toHaveText(owner.email);
  for(const label of ["好友管理","团队管理","检查更新","设置","退出登录"])await expect(account(page).getByRole("menuitem",{name:label,exact:true})).toBeVisible();
  await expect(account(page).getByRole("menuitem")).toHaveText(["工作空间切换","好友管理","团队管理","检查更新","设置","退出登录"]);
  const choices=await openWorkspaceSwitcher(page);await expect(choices.getByRole("menuitemradio")).toHaveCount(4);
  for(const label of ["本地模式","个人",teamA.name,teamB.name])await expect(choices.getByRole("menuitemradio",{name:label,exact:true})).toBeVisible();
  await choices.getByRole("menuitemradio",{name:teamA.name,exact:true}).click();await expect(page.locator(".academic-page-header h1")).toHaveText(teamA.name);await noExtraHeaderRow(page);
  await switchWorkspace(page,teamB.name);await expect(page.locator(".academic-page-header h1")).toHaveText(teamB.name);
  await switchWorkspace(page,"个人");await expect(page.locator(".academic-page-header h1")).toHaveText("首页");
  await avatar(page).click();await account(page).getByRole("menuitem",{name:"好友管理",exact:true}).click();await expect(page.locator(".academic-page-header h1")).toContainText("好友");await noExtraHeaderRow(page);
  await avatar(page).click();await account(page).getByRole("menuitem",{name:"团队管理",exact:true}).click();await expect(page.getByRole("heading",{name:"我的团队",exact:true,level:1})).toBeVisible();await noExtraHeaderRow(page);
  await page.goto("anote://app/?scope="+teamA.id+"&space="+library.id+"&doc="+note.id);await expect(page.getByTestId("editor")).toBeVisible();await noExtraHeaderRow(page,true);
  const draft="取消本地目录时保留的服务器原稿 "+randomUUID();await page.getByTestId("editor").locator(":scope > p").last().click();await page.keyboard.insertText(draft);
  await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});await switchWorkspace(page,"本地模式");await expect(account(page)).toBeHidden();
  expect(!!(await page.evaluate(()=>window.anote.state())).personal).toBe(false);expect((await page.evaluate(()=>window.anote.state())).user?.id).toBe(owner.state.user!.id);await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(note.title);await expect(page.getByTestId("editor")).toContainText(draft);
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},files.directory);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,900));await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(1000);await noExtraHeaderRow(page,true);
  const title=page.getByLabel("笔记标题",{exact:true});expect((await title.boundingBox())!.width).toBeGreaterThan(40);
  await title.click();await title.press("End");await page.keyboard.insertText(" · 窄窗可编辑");await page.keyboard.press("ControlOrMeta+s");await expect.poll(async()=>(await api(request,"GET","documents/"+note.id,undefined,owner)).title).toBe("Native compact document · 窄窗可编辑");
  await page.getByRole("button",{name:"收起侧边栏",exact:true}).click();await expect(page.getByRole("button",{name:"展开侧边栏",exact:true})).toBeVisible();await noExtraHeaderRow(page,true);
  await avatar(page).focus();await page.keyboard.press("ArrowDown");await expect(account(page)).toBeVisible();await page.keyboard.press("Escape");await expect(avatar(page)).toBeFocused();
  await avatar(page).click();await account(page).getByRole("menuitem",{name:"设置",exact:true}).click();const settings=page.getByRole("dialog",{name:"设置",exact:true});await expect(settings).toBeVisible();await settings.locator(":scope > header").getByRole("button",{name:"关闭",exact:true}).click();
  await page.screenshot({path:`artifacts/desktop/${executable?"packaged-":""}compact-account-native-server.png`});
  await avatar(page).click();await account(page).getByRole("menuitem",{name:"退出登录",exact:true}).click();await expect(page.getByRole("button",{name:"连接服务器",exact:true})).toBeVisible();
});

test("真实本地模式：二级菜单保留本地与服务器个人入口，底栏切换外观，菜单检查更新不触发下载",async()=>{
  const files=await fixture(),requests:string[]=[],version=JSON.parse(await fs.readFile("apps/desktop/package.json","utf8")).version;
  const server=http.createServer((request,response)=>{
    requests.push(request.url!);const url=new URL(request.url!,"http://metadata-only");response.setHeader("Content-Type","application/json");response.setHeader("Cache-Control","no-store");
    if(url.pathname==="/api/client-releases/check"){
      const platform=url.searchParams.get("platform"),arch=url.searchParams.get("arch"),file=`ANote-${version}-${platform}-${arch}.${platform==="win32"?"zip":"tar.gz"}`;
      response.end(JSON.stringify({version,editor_schema:8,signed:false,requires_auth:true,packages:[{platform,arch,file,bytes:1234,sha256:"a".repeat(64),url:"/api/client-releases/"+file}]}));return;
    }
    response.writeHead(401).end(JSON.stringify({error:"This fixture exposes metadata only"}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));servers.push(server);const address=server.address();if(!address||typeof address==="string")throw new Error("No isolated metadata origin");
  await fs.writeFile(path.join(files.profile,"settings.json"),JSON.stringify({serverURL:`http://127.0.0.1:${address.port}`,user:null,offline:false,workspace:"",documents:[],lastDoc:null}));
  const {app,page}=await launch(files.profile,files.directory);
  await page.getByRole("button",{name:"本地个人笔记",exact:true}).click();await expect(tools(page)).toBeVisible();
  await page.evaluate(async()=>{const response=await fetch("/api/me/profile",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Alice Local"})});if(!response.ok)throw new Error("Local fixture nickname failed");});await expect(avatar(page)).toHaveText("A");
  await page.locator(".academic-page-actions").getByRole("button",{name:"新建笔记",exact:true}).click();await expect(page.getByTestId("editor")).toBeVisible();await noExtraHeaderRow(page,true);
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90" viewBox="0 0 180 90"><rect width="180" height="90" fill="#3b73dd"/><circle cx="90" cy="45" r="24" fill="#fff"/></svg>');
  await page.getByLabel("上传附件文件",{exact:true}).setInputFiles({name:"本地矢量图.svg",mimeType:"image/svg+xml",buffer:svg});
  const image=page.locator('.media-resource[data-media-kind="image"] img');await expect(image).toBeVisible();await expect.poll(()=>image.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(180);
  await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存到本地");
  for(const theme of ["dark","light","auto"] as const){
    await avatar(page).click();await expect(account(page).locator(".workspace-account-identity strong")).toHaveText("Alice Local");await expect(account(page).locator(".workspace-account-identity small")).toHaveCount(0);
    await expect(account(page).getByRole("group",{name:"外观",exact:true})).toHaveCount(0);await page.keyboard.press("Escape");
    await chooseTheme(page,theme);
  }
  await expect(page.getByRole("navigation",{name:"辅助导航",exact:true}).getByRole("button",{name:"外观模式",exact:true})).toBeVisible();
  const choices=await openWorkspaceSwitcher(page);await expect(choices.getByRole("menuitemradio")).toHaveText(["本地模式","个人"]);await expect(choices.getByRole("menuitemradio",{name:"本地模式",exact:true})).toHaveAttribute("aria-checked","true");await expect(choices.getByRole("menuitemradio",{name:"个人",exact:true})).toHaveAttribute("aria-checked","false");await page.keyboard.press("Escape");await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"收起侧边栏",exact:true}).click();await noExtraHeaderRow(page,true);await expect(page.getByRole("button",{name:"展开侧边栏",exact:true})).toBeVisible();
  await expect.poll(async()=>!!(await page.evaluate(()=>window.anote.updateState!())).checkedAt).toBe(true);
  const prior=(await page.evaluate(()=>window.anote.updateState!())).checkedAt,count=requests.filter(url=>url.startsWith("/api/client-releases/check?")).length;
  await avatar(page).click();await account(page).getByRole("menuitem",{name:"检查更新",exact:true}).click();const settings=page.getByRole("dialog",{name:"设置",exact:true});await expect(settings.locator(".client-update-panel")).toBeVisible();
  await expect.poll(()=>requests.filter(url=>url.startsWith("/api/client-releases/check?")).length).toBeGreaterThan(count);
  await expect.poll(async()=>(await page.evaluate(()=>window.anote.updateState!())).checkedAt).not.toBe(prior);
  const state=await page.evaluate(()=>window.anote.updateState!());expect(state.status).toBe("up-to-date");expect(state.downloadPath).toBeNull();expect(state.canInstall).toBe(false);expect(requests.every(url=>url.startsWith("/api/client-releases/check?"))).toBe(true);
  await settings.locator(":scope > header").getByRole("button",{name:"关闭",exact:true}).click();await expect(page.getByTestId("editor")).toBeVisible();await noExtraHeaderRow(page,true);
  await page.screenshot({path:`artifacts/desktop/${executable?"packaged-":""}compact-account-native-personal.png`});
  expect((await page.evaluate(()=>window.anote.state())).personal).toBe(true);expect(await app.evaluate(({app})=>app.isPackaged)).toBe(!!executable);
  await app.close();applications.splice(applications.indexOf(app),1);
  const reopened=await launch(files.profile,files.directory);await expect(reopened.page.getByTestId("editor")).toBeVisible();
  const persisted=reopened.page.locator('.media-resource[data-media-kind="image"] img');await expect(persisted).toBeVisible();await expect.poll(()=>persisted.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(180);
});

import {test,expect,type Page} from "@playwright/test";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
let script="";
test.beforeAll(async()=>{
  const built=await build({stdin:{resolveDir:fileURLToPath(new URL("../../../",import.meta.url)),loader:"tsx",contents:`
    import React from "react";import{createRoot}from"react-dom/client";
    import{ClientUpdatePanel,ClientUpdateBanner,useClientUpdateNotification,connectForClientUpdate}from"./apps/desktop/renderer/client-updates";
    import{SocialPage,useSocialBadges}from"./apps/desktop/renderer/social";
    const options=window.__clientUpdateOptions||{},listeners=new Set(),calls=[],pending=[],initial=[];
    let state={status:"idle",currentVersion:"0.4.15",latestVersion:null,downloadedBytes:0,totalBytes:0,progress:0,error:null,checkedAt:null,downloadPath:null,canInstall:false,needsAuth:false,release:null,...options.state};
    let serverUnread=2;const requests=[];window.fetch=async(input,settings)=>{const url=String(input),method=settings?.method||"GET";requests.push({url,method});if(url.includes("social/badges"))return Response.json({unread:serverUnread,requests:0});if(method==="POST")serverUnread=0;return Response.json({items:[],next_offset:null});};
    function emit(patch){state={...state,...patch};for(const callback of listeners)callback({updates:structuredClone(state)});}
    function invoke(method){calls.push(method);return new Promise((resolve,reject)=>pending.push({method,resolve,reject}));}
    window.anote={updateState:()=>options.deferInitial?new Promise((resolve,reject)=>initial.push({resolve,reject})):options.initialError?Promise.reject(new Error(options.initialError)):Promise.resolve(structuredClone(state)),onState:callback=>{listeners.add(callback);return()=>listeners.delete(callback);},checkUpdates:()=>invoke("check"),downloadUpdate:()=>invoke("download"),installUpdate:()=>invoke("install"),openUpdateFolder:()=>invoke("folder")};
    window.__updateTest={calls,requests,connects:0,emit,resolveInitial:value=>{for(const item of initial.splice(0))item.resolve(value);},complete:(method,patch,error)=>{if(patch)emit(patch);const item=pending.find(item=>item.method===method);pending.splice(pending.indexOf(item),1);error?item.reject(new Error(error)):item.resolve(structuredClone(state));}};
    window.addEventListener("anote-connect-server",()=>{window.__updateTest.connects++;});
    function Harness(){const notice=useClientUpdateNotification(),localOnly=options.localOnly!==false,badges=useSocialBadges(localOnly);return <><output data-testid="update-unread">{(localOnly?0:badges.unread)+(notice&&!notice.read?1:0)}</output><ClientUpdatePanel initialState={state}/><ClientUpdateBanner/><SocialPage page="notifications" userId="local" offline={localOnly} localOnly={localOnly} clientUpdate={notice} onClientUpdate={()=>{notice?.markRead();connectForClientUpdate();}} onOpenNote={()=>{}} onFriends={()=>{}} onError={error=>{throw error;}}/></>;}
    createRoot(document.getElementById("root")).render(<Harness/>);
  `},bundle:true,platform:"browser",format:"iife",write:false,loader:{".css":"empty"},define:{"process.env.NODE_ENV":'"test"'}});script=built.outputFiles[0].text;
});

const release={version:"0.4.16",platform:"linux",arch:"x64",file:"ANote-0.4.16-linux-x64.tar.gz",sha256:"a".repeat(64),bytes:128_000_000};
async function mount(page:Page,options:any={}){await page.setContent('<div id="root"></div>');await page.evaluate(value=>(window as any).__clientUpdateOptions=value,options);await page.addScriptTag({content:script});await expect(page.getByRole("heading",{name:"客户端更新",exact:true})).toBeVisible();}
const banner=(page:Page)=>page.getByRole("complementary",{name:"客户端版本更新",exact:true});
const panel=(page:Page)=>page.getByRole("region",{name:"客户端更新",exact:true});

test("匿名发现仅版本也提示并引导连接，不自动下载，个人通知不请求私有API",async({page})=>{
  await mount(page,{state:{status:"available",latestVersion:"0.4.16",needsAuth:true,checkedAt:"2026-11-06T01:00:00Z"}});
  await expect(banner(page)).toContainText("ANote 0.4.16 已可更新");await expect(panel(page)).toContainText("当前版本 0.4.15");await expect(panel(page)).toContainText("最近检查：");
  await banner(page).getByRole("button",{name:"连接服务器后下载更新",exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__updateTest.connects)).toBe(1);expect(await page.evaluate(()=>(window as any).__updateTest.calls)).toEqual([]);expect(await page.evaluate(()=>(window as any).__updateTest.requests)).toEqual([]);
});

test("已知新版下载失败仍显示Banner，可异步重试并恢复到安装动作",async({page})=>{
  await mount(page,{state:{status:"available",latestVersion:"0.4.16",release}});
  await panel(page).getByRole("button",{name:"下载更新",exact:true}).click();await expect(panel(page).getByRole("button",{name:"下载更新",exact:true})).toBeDisabled();
  await page.evaluate(()=>(window as any).__updateTest.complete("download",{status:"error",error:"下载连接中断"},"下载连接中断"));
  await expect(banner(page)).toBeVisible();await expect(banner(page).getByRole("alert")).toHaveText("下载连接中断");
  await banner(page).getByRole("button",{name:"重试下载",exact:true}).click();await expect(banner(page).getByRole("button",{name:"重试下载",exact:true})).toBeDisabled();
  await page.evaluate(()=>(window as any).__updateTest.complete("download",{status:"ready",error:null,canInstall:true,downloadPath:"/updates/archive"}));
  await expect(banner(page).getByRole("button",{name:"保存并重启更新",exact:true})).toBeEnabled();await expect(panel(page).getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__updateTest.calls)).toEqual(["download","download"]);
});

test("未知检查失败仅设置显示原因，最近检查与当前版本可见并可重试",async({page})=>{
  await mount(page,{state:{status:"error",error:"服务器暂不可用",checkedAt:"2026-11-06T01:00:00Z"}});
  await expect(banner(page)).toHaveCount(0);await expect(panel(page).getByRole("alert")).toHaveText("服务器暂不可用");await expect(panel(page)).toContainText("当前版本 0.4.15");await expect(panel(page)).toContainText("最近检查：");
  await panel(page).getByRole("button",{name:"检查更新",exact:true}).click();await expect(panel(page).getByRole("button",{name:"检查更新",exact:true})).toBeDisabled();
  await page.evaluate(()=>(window as any).__updateTest.complete("check",{status:"up-to-date",latestVersion:"0.4.15",error:null}));await expect(panel(page)).toContainText("当前已是最新版本");await expect(banner(page)).toHaveCount(0);
});

test("较慢的初始IPC回包不会覆盖先到的新版本通知",async({page})=>{
  await mount(page,{deferInitial:true});await page.evaluate(()=>(window as any).__updateTest.emit({status:"available",latestVersion:"0.4.16",needsAuth:true}));await expect(banner(page)).toBeVisible();
  await page.evaluate(()=>(window as any).__updateTest.resolveInitial({status:"idle",currentVersion:"0.4.15",latestVersion:null}));await expect(banner(page)).toContainText("0.4.16");await expect(page.getByTestId("update-unread")).toHaveText("1");
});

test("稍后只关闭Banner，提醒中心保留、可本地已读，安装到对应版本自动移除",async({page})=>{
  await mount(page,{state:{status:"available",latestVersion:"0.4.16",needsAuth:true}});await expect(page.getByTestId("update-unread")).toHaveText("1");
  await banner(page).getByRole("button",{name:"稍后",exact:true}).click();await expect(banner(page)).toHaveCount(0);const row=page.locator("article[data-client-update]");await expect(row).toContainText("0.4.16");
  await row.getByRole("button",{name:"标为已读",exact:true}).click();await expect(page.getByTestId("update-unread")).toHaveText("0");await expect(row).toBeVisible();expect(await page.evaluate(()=>(window as any).__updateTest.requests)).toEqual([]);
  await row.getByRole("button",{name:"连接服务器后下载更新",exact:true}).click();expect(await page.evaluate(()=>(window as any).__updateTest.connects)).toBe(1);
  await page.evaluate(()=>(window as any).__updateTest.emit({currentVersion:"0.4.16",latestVersion:"0.4.16",status:"up-to-date"}));await expect(row).toHaveCount(0);await expect(page.getByTestId("update-unread")).toHaveText("0");
});

test("服务器未读与设备更新未读合并，本地标读不向服务器创建通知",async({page})=>{
  await mount(page,{localOnly:false,state:{status:"available",latestVersion:"0.4.16",release}});await expect(page.getByTestId("update-unread")).toHaveText("3");
  await page.locator("article[data-client-update]").getByRole("button",{name:"标为已读",exact:true}).click();await expect(page.getByTestId("update-unread")).toHaveText("2");
  expect(await page.evaluate(()=>(window as any).__updateTest.requests.filter((value:any)=>value.method!=="GET"))).toEqual([]);
  await page.getByRole("button",{name:"全部标为已读",exact:true}).click();await expect(page.getByTestId("update-unread")).toHaveText("0");
  expect(await page.evaluate(()=>(window as any).__updateTest.requests.filter((value:any)=>value.method!=="GET"))).toEqual([{url:"/api/notifications/read",method:"POST"}]);
});

test("初始状态读取失败在设置可见，仍能手动检查恢复",async({page})=>{
  await mount(page,{initialError:"读取客户端状态失败"});await expect(panel(page).getByRole("alert")).toHaveText("读取客户端状态失败");await expect(panel(page)).toContainText("0.4.15");await expect(banner(page)).toHaveCount(0);
  await panel(page).getByRole("button",{name:"检查更新",exact:true}).click();await page.evaluate(()=>(window as any).__updateTest.complete("check",{status:"available",latestVersion:"0.4.16",needsAuth:true}));await expect(panel(page).getByRole("alert")).toHaveCount(0);await expect(banner(page)).toBeVisible();
});

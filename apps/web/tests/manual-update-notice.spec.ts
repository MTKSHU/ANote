import {test,expect,type Page} from "@playwright/test";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";

const currentEntry="/assets/index-current1.js";
let script="";
test.beforeAll(async()=>{
  const result=await build({
    stdin:{resolveDir:fileURLToPath(new URL("../../../",import.meta.url)),loader:"tsx",contents:`
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {WebUpdateNotice} from "./apps/web/src/update-notice";
      window.__beforeReloadCalls=0;
      createRoot(document.getElementById("root")).render(<WebUpdateNotice onBeforeReload={async()=>{window.__beforeReloadCalls++;throw new Error("保存失败，请重试");}}/>);
    `},bundle:true,platform:"browser",format:"iife",write:false,loader:{".css":"empty"},define:{"process.env.NODE_ENV":'"test"'},
  });script=result.outputFiles[0].text;
});
async function mount(page:Page){
  await page.route("https://anote.test/",route=>route.fulfill({contentType:"text/html; charset=utf-8",body:`<meta charset="utf-8"><textarea aria-label="笔记草稿"></textarea><main id="root"></main><script type="module" src="${currentEntry}"></script>`}));
  await page.route("https://anote.test/assets/**",route=>route.fulfill({contentType:"application/javascript",body:""}));
  await page.goto("https://anote.test/");await page.addScriptTag({content:script});
  await page.getByLabel("笔记草稿",{exact:true}).fill("尚未保存的笔记内容");
}
const notice=(page:Page)=>page.getByRole("status",{name:"平台更新提醒",exact:true});
async function manual(page:Page){await page.evaluate(()=>window.dispatchEvent(new Event("anote-check-web-update")));}
test("手动检查同版有短暂反馈，不刷新页面或触发保存",async({page})=>{
  let checks=0;
  await page.route("**/api/version",route=>{checks++;return route.fulfill({json:{web_entry:currentEntry}});});
  await page.clock.install();await mount(page);await expect.poll(()=>checks).toBeGreaterThan(0);await expect(notice(page)).toHaveCount(0);
  const previous=checks;await manual(page);await expect(notice(page)).toHaveText("当前已是最新版本关闭");expect(checks).toBeGreaterThan(previous);
  await expect(page.getByLabel("笔记草稿",{exact:true})).toHaveValue("尚未保存的笔记内容");
  expect(await page.evaluate(()=>(window as any).__beforeReloadCalls)).toBe(0);
  await page.clock.fastForward(5_001);await expect(notice(page)).toHaveCount(0);
});
test("手动检查重新显示曾点稍后的版本，后续自动检查不再次隐藏",async({page})=>{
  let current="/assets/index-next_123.js",checks=0;
  await page.route("**/api/version",route=>{checks++;return route.fulfill({json:{web_entry:current}});});
  await mount(page);await expect(notice(page)).toContainText("平台已更新");
  await notice(page).getByRole("button",{name:"稍后",exact:true}).click();await expect(notice(page)).toHaveCount(0);
  let prior=checks;await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await expect.poll(()=>checks).toBeGreaterThan(prior);await expect(notice(page)).toHaveCount(0);
  await manual(page);await expect(notice(page).getByRole("button",{name:"保存并刷新",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem("anote:web-update-dismissed"))).toBeNull();
  prior=checks;await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await expect.poll(()=>checks).toBeGreaterThan(prior);await expect(notice(page)).toBeVisible();
  await notice(page).getByRole("button",{name:"保存并刷新",exact:true}).click();await expect(notice(page).getByRole("alert")).toHaveText("保存失败，请重试");
  await expect(page.getByLabel("笔记草稿",{exact:true})).toHaveValue("尚未保存的笔记内容");
  current=currentEntry;await manual(page);await expect(notice(page)).toContainText("当前已是最新版本");
});
test("自动断网静默，手动失败可重试并保留草稿",async({page})=>{
  let mode="offline",checks=0;
  await page.route("**/api/version",route=>{
    checks++;
    if(mode==="offline")return route.abort("internetdisconnected");
    if(mode==="server")return route.fulfill({status:503,json:{error:"Unavailable"}});
    if(mode==="invalid")return route.fulfill({json:{web_entry:"https://untrusted.test/script.js"}});
    return route.fulfill({json:{web_entry:currentEntry}});
  });
  await mount(page);await expect.poll(()=>checks).toBeGreaterThan(0);await expect(notice(page)).toHaveCount(0);
  await manual(page);await expect(notice(page).getByRole("alert")).toHaveText("无法连接服务器，请检查网络后重试。");
  mode="server";await notice(page).getByRole("button",{name:"重试",exact:true}).click();await expect(notice(page).getByRole("alert")).toContainText("HTTP 503");
  mode="invalid";await notice(page).getByRole("button",{name:"重试",exact:true}).click();await expect(notice(page).getByRole("alert")).toHaveText("服务器版本信息暂不可用，请稍后重试。");
  mode="ok";await notice(page).getByRole("button",{name:"重试",exact:true}).click();await expect(notice(page)).toContainText("当前已是最新版本");
  await expect(page.getByLabel("笔记草稿",{exact:true})).toHaveValue("尚未保存的笔记内容");expect(await page.evaluate(()=>(window as any).__beforeReloadCalls)).toBe(0);
});
test("手动操作共用进行中的自动检查，重复点击不会并发请求",async({page})=>{
  let checks=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/version",async route=>{checks++;await gate;await route.fulfill({json:{web_entry:"/assets/index-next_123.js"}});});
  await mount(page);await expect.poll(()=>checks).toBe(1);
  await manual(page);await manual(page);await expect(notice(page)).toContainText("正在检查更新");expect(checks).toBe(1);
  release();await expect(notice(page)).toContainText("平台已更新");expect(checks).toBe(1);
});

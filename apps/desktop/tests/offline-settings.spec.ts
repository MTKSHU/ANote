import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script = "";
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "tsx",
      contents: `
        import React from "react";
        import {createRoot} from "react-dom/client";
        import {OfflineControls} from "./apps/desktop/renderer/offline-controls";
        const listeners = new Set();
        const calls = [];
        let failDownload = false;
        let configureGate = null;
        let deleteGate = null;
        let failDelete = false;
        let status = {
          config:{enabled:false,scope:"all-readable",libraryIds:[],includeAssets:true,backupDirectory:"/test/backups",retention:10,backupIntervalMinutes:15},
          enabled:false,pullState:"disabled",complete:false,lastPullAttempt:null,lastCacheUpdate:null,unavailable:0,availableDocuments:2,assetsTotal:2,assetsMissing:1,
          configured:false,libraries:[{id:"first",name:"研究",team_name:"团队甲"},{id:"second",name:"项目"}],
          backups:[{id:"old-backup",createdAt:"2026-11-05T01:00:00Z",documents:2,assets:1}],
          progress:null,networkOnline:false,automaticOffline:true,running:false,lastError:"",lastDownload:null,lastBackup:null,documents:2,pending:1,conflicts:[],assets:1,
        };
        let state = {desktop:true,personal:false,stateRevision:1,serverURL:"https://notes.example",user:{id:"owner",name:"作者",role:"user"},token:null,offline:false,workspace:"",lastDoc:null,credentialWarning:"",sync:{running:false,pending:[],documents:[]},offlineStorage:status};
        function emit(patch={}) {status={...status,...patch};state={...state,stateRevision:state.stateRevision+1,offlineStorage:status};for(const listener of listeners)listener(state);}
        window.anote={
          offlineStatus:async()=>structuredClone(status),
          onState:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
          configureOffline:async config=>{calls.push({method:"configure",config:structuredClone(config)});if(configureGate)await configureGate.promise;emit({config:structuredClone(config),enabled:config.enabled,pullState:config.enabled?"idle":"disabled",complete:false});return structuredClone(status);},
          downloadOffline:async()=>{calls.push({method:"download"});if(failDownload)throw new Error("连接中断，请重试");emit({lastDownload:"2026-11-05T02:00:00Z",complete:true,pullState:"idle",assets:2,assetsMissing:0});return structuredClone(status);},
          syncOffline:async()=>{calls.push({method:"sync"});emit({pending:0});return structuredClone(status);},
          chooseBackupDirectory:async()=>"/test/other-backups",
          createBackup:async()=>{calls.push({method:"backup"});emit({lastBackup:"2026-11-05T03:00:00Z",backups:[{id:"new-backup",createdAt:"2026-11-05T03:00:00Z",documents:2,assets:1},...status.backups]});},
          listBackups:async()=>structuredClone(status.backups),
          deleteBackup:async id=>{calls.push({method:"delete",id});if(deleteGate)await deleteGate.promise;if(failDelete)throw new Error("备份删除失败，请重试");emit({backups:status.backups.filter(item=>item.id!==id)});return structuredClone(status);},
          restoreBackup:async id=>{calls.push({method:"restore",id});emit({pending:2});return structuredClone(status);},
          resolveOfflineConflict:async(id,choice)=>{calls.push({method:"resolve",id,choice});emit({conflicts:status.conflicts.filter(item=>item.id!==id)});return structuredClone(status);},
          openBackupFolder:async()=>{calls.push({method:"openFolder"});},
        };
        const root=createRoot(document.getElementById("root"));
        const render=()=>root.render(<div data-offline-account={state.user.id}><OfflineControls state={state}/></div>);
        window.__offlineTest={calls,emit,failDownload:value=>{failDownload=value;},failDelete:value=>{failDelete=value;},deferDelete:()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});deleteGate={promise,resolve};},completeDelete:()=>{const gate=deleteGate;deleteGate=null;gate.resolve();},deferConfigure:()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});configureGate={promise,resolve,reject};},completeConfigure:error=>{const gate=configureGate;configureGate=null;if(error)gate.reject(new Error(error));else gate.resolve();},personal:()=>{state={...state,personal:true};render();},account:id=>{state={...state,user:{...state.user,id}};render();},state:patch=>{state={...state,...patch};render();}};
        render();
      `,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});

async function mount(page: Page) {
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: script });
  await expect(page.getByText("正在读取本地副本…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存设置", exact: true })).toBeEnabled();
}

async function advanced(page: Page, selected = false) {
  const panel = page.locator(".offline-advanced");
  if (await panel.getAttribute("open") === null) await panel.locator("summary").click();
  if (selected) await page.getByLabel("本地副本保存范围", { exact: true }).selectOption("selected");
}

test("配置草稿不被后台状态通知覆盖，保存选库、附件与备份选项", async ({ page }) => {
  await mount(page);
  await advanced(page, true);
  await page.getByLabel("离线知识库：研究", { exact: true }).uncheck();
  await page.getByLabel("离线知识库：项目", { exact: true }).check();
  await page.getByLabel("同时下载图片、视频和其他附件", { exact: true }).check();
  await page.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(page.getByLabel("备份目录", { exact: true })).toHaveValue("/test/other-backups");
  await page.getByLabel("自动备份间隔", { exact: true }).selectOption("60");
  await page.getByLabel("备份保留数量", { exact: true }).selectOption("7");
  await page.evaluate(() => (window as any).__offlineTest.emit({ pending: 3, progress: { completed: 1, total: 4, assetsCompleted: 0, assetsTotal: 2, currentTitle: "正在下载另一篇笔记" } }));
  await expect(page.getByText("3 篇待上传", { exact: true })).toBeVisible();
  await expect(page.getByLabel("离线知识库：项目", { exact: true })).toBeChecked();
  await expect(page.getByLabel("离线知识库：研究", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("离线副本下载进度", { exact: true })).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__offlineTest.calls)).toEqual([{ method: "configure", config: { enabled: false, scope: "selected", libraryIds: ["second"], includeAssets: true, backupDirectory: "/test/other-backups", retention: 7, backupIntervalMinutes: 60 } }]);
  await expect(page.getByText("离线与备份设置已保存", { exact: true })).toBeVisible();
});

test("无联网凭据仍能备份与恢复，取消恢复不会调用主进程", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "立即备份", exact: true }).click();
  await expect(page.getByText("本地备份已完成", { exact: true })).toBeVisible();
  await expect(page.getByLabel("本地备份列表", { exact: true }).locator("article")).toHaveCount(2);
  await page.getByLabel("本地备份列表", { exact: true }).getByRole("button", { name: /^恢复备份：/ }).last().click();
  const dialog = page.getByRole("dialog", { name: "恢复本地备份", exact: true });
  await expect(dialog).toContainText("恢复前会先保留当前本地副本");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__offlineTest.calls.filter((call: any) => call.method === "restore"))).toEqual([]);
  await page.getByLabel("本地备份列表", { exact: true }).getByRole("button", { name: /^恢复备份：/ }).last().click();
  await dialog.getByRole("button", { name: "保留当前副本并恢复", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__offlineTest.calls.filter((call: any) => call.method === "restore"))).toEqual([{ method: "restore", id: "old-backup" }]);
  await expect(page.getByText("2 篇待上传", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开备份目录", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__offlineTest.calls.some((call: any) => call.method === "openFolder"))).toBe(true);
});

test("下载失败可见且允许重试，待上传可以手动同步", async ({ page }) => {
  await mount(page);
  await page.getByRole("switch", { name: "始终保留服务器笔记的本地副本", exact: true }).check();
  await page.evaluate(() => (window as any).__offlineTest.failDownload(true));
  const download = page.getByRole("button", { name: "立即更新本地副本", exact: true });
  await download.click();
  await expect(page.getByRole("alert")).toHaveText("连接中断，请重试");
  await expect(download).toBeEnabled();
  await page.evaluate(() => (window as any).__offlineTest.failDownload(false));
  await download.click();
  await expect(page.getByText("本地副本已更新", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试上传本地修改", exact: true }).click();
  await expect(page.getByText("0 篇待上传", { exact: true })).toBeVisible();
});

test("独立离线个人目录显示说明，隐藏平台副本与备份动作", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).__offlineTest.personal());
  await expect(page.getByRole("heading", { name: "平台笔记的离线副本与备份", exact: true })).toBeVisible();
  await expect(page.getByLabel("离线与备份设置", { exact: true })).toContainText("独立离线个人目录已有本地保存");
  await expect(page.getByRole("button", { name: "立即备份", exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "始终保留服务器笔记的本地副本", exact: true })).toHaveCount(0);
});

test("切换账号会重置旧账号未保存的设置草稿", async ({ page }) => {
  await mount(page);
  await advanced(page, true);
  await page.getByLabel("离线知识库：项目", { exact: true }).check();
  await page.getByLabel("同时下载图片、视频和其他附件", { exact: true }).uncheck();
  await page.evaluate(() => (window as any).__offlineTest.account("another-owner"));
  await expect(page.locator("[data-offline-account]")).toHaveAttribute("data-offline-account", "another-owner");
  await advanced(page);
  await expect(page.getByLabel("本地副本保存范围", { exact: true })).toHaveValue("all-readable");
  await expect(page.getByLabel("同时下载图片、视频和其他附件", { exact: true })).toBeChecked();
  await page.getByLabel("本地副本保存范围", { exact: true }).selectOption("selected");
  await expect(page.getByLabel("离线知识库：项目", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("离线知识库：研究", { exact: true })).not.toBeChecked();
});

test("常驻本地副本默认关闭，开启一次配置全部可读内容和附件，不重复下载", async ({ page }) => {
  await mount(page);
  const toggle = page.getByRole("switch", { name: "始终保留服务器笔记的本地副本", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel("本地副本完整性", { exact: true })).toContainText("自动保留已关闭");
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as any).__offlineTest.calls)).toEqual([{ method: "configure", config: { enabled: true, scope: "all-readable", libraryIds: [], includeAssets: true, backupDirectory: "/test/backups", retention: 10, backupIntervalMinutes: 15 } }]);
  await page.evaluate(() => (window as any).__offlineTest.emit({ pullState: "running", running: true, progress: { completed: 1, total: 2, assetsCompleted: 1, assetsTotal: 3, currentTitle: "正在保存项目笔记" } }));
  await expect(page.getByLabel("本地副本完整性", { exact: true })).toContainText("尚未完整");
  await expect(page.getByLabel("离线副本下载进度", { exact: true })).toHaveAttribute("value", "1");
  await expect(page.getByLabel("本地副本完整性", { exact: true })).toContainText("还有 1 个附件未保存");
  await page.evaluate(() => (window as any).__offlineTest.emit({ pullState: "idle", running: false, progress: null, complete: true, assetsMissing: 0, lastDownload: "2026-11-06T01:00:00Z" }));
  await expect(page.getByLabel("本地副本完整性", { exact: true })).toContainText("本地副本已完整");
});

test("关闭常驻副本保留待上传内容和备份，权限清单更新不保留旧库选项", async ({ page }) => {
  await mount(page);
  const toggle = page.getByRole("switch", { name: "始终保留服务器笔记的本地副本", exact: true });
  await toggle.check();
  await page.evaluate(() => (window as any).__offlineTest.emit({ pending: 3 }));
  await toggle.uncheck();
  await expect(page.getByText("3 篇待上传", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "立即备份", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "立即更新本地副本", exact: true })).toHaveCount(0);
  await advanced(page, true);
  await expect(page.getByLabel("离线知识库：研究", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__offlineTest.emit({ libraries: [] }));
  await expect(page.getByLabel("离线知识库：研究", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__offlineTest.calls.filter((call: any) => call.method === "configure").at(-1).config.enabled)).toBe(false);
});

test("主开关即时响应延迟配置，后台通知不覆盖，失败回滚后可重试", async ({ page }) => {
  await mount(page);
  const toggle = page.getByRole("switch", { name: "始终保留服务器笔记的本地副本", exact: true });
  await page.evaluate(() => (window as any).__offlineTest.deferConfigure());
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as any).__offlineTest.emit({ enabled: false, pending: 2 }));
  await expect(toggle).toBeChecked();
  await page.evaluate(() => (window as any).__offlineTest.completeConfigure("配置保存失败，请重试"));
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveText("配置保存失败，请重试");
  await page.evaluate(() => (window as any).__offlineTest.deferConfigure());
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as any).__offlineTest.completeConfigure());
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await page.evaluate(() => (window as any).__offlineTest.deferConfigure());
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as any).__offlineTest.completeConfigure("关闭失败"));
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveText("关闭失败");
});

test("标题冲突展示服务器标题，分别支持本地和服务器标题；权限冲突不显示标题操作", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).__offlineTest.emit({ conflicts: [
    { id: "local", kind: "title", title: "本地研究标题", error: "笔记标题已被其他人修改，本地副本已保留", remoteTitle: "服务器研究标题" },
    { id: "remote", title: "本地项目标题", error: "笔记标题已被其他人修改，本地副本已保留", remoteTitle: "服务器项目标题" },
    { id: "forbidden", kind: "permission", title: "无编辑权限", error: "当前没有编辑标题的权限，本地副本已保留" },
  ] }));
  await expect(page.getByText("服务器标题：服务器研究标题", { exact: true })).toBeVisible();
  const local = page.locator(".offline-conflicts li").filter({ hasText: "本地研究标题" });
  await local.getByRole("button", { name: "保留本地标题", exact: true }).click();
  const remote = page.locator(".offline-conflicts li").filter({ hasText: "本地项目标题" });
  await remote.getByRole("button", { name: "使用服务器标题", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__offlineTest.calls.filter((call: any) => call.method === "resolve"))).toEqual([
    { method: "resolve", id: "local", choice: "local-title" }, { method: "resolve", id: "remote", choice: "remote-title" },
  ]);
  await expect(page.locator(".offline-conflicts li").filter({ hasText: "无编辑权限" }).getByRole("button")).toHaveCount(0);
});

test("格式校验冲突保留原稿并提供手动重试，不显示标题二选一",async({page})=>{
  await mount(page);await page.evaluate(()=>(window as any).__offlineTest.emit({conflicts:[{id:"invalid",kind:"validation",title:"待修复的本地记录",error:"正文格式校验未通过，本地原稿已保留"}]}));
  const row=page.locator(".offline-conflicts li").filter({hasText:"待修复的本地记录"});await expect(row.getByRole("button",{name:"保留本地标题",exact:true})).toHaveCount(0);
  await row.getByRole("button",{name:"重试同步",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__offlineTest.calls.filter((call:any)=>call.method==="sync").length)).toBe(1);await expect(page.getByRole("status").filter({hasText:"本地原稿会保留"})).toBeVisible();
});

async function backupHistory(page:Page,count:number) {
  await page.evaluate(total=>(window as any).__offlineTest.emit({backups:Array.from({length:total},(_,index)=>({id:"history-"+index,createdAt:new Date(Date.UTC(2026,10,6,12,0,-index)).toISOString(),documents:index+1,assets:1,incremental:true}))}),count);
}

test("备份每页十条，末页取消删除不调用主进程；确认后夹取页码并保留其他记录",async({page})=>{
  await mount(page);await backupHistory(page,21);
  const list=page.getByLabel("本地备份列表",{exact:true}),pagination=page.getByRole("navigation",{name:"本地备份分页",exact:true});
  await expect(list.locator("article")).toHaveCount(10);await expect(pagination).toContainText("共 21 份 · 第 1 / 3 页");await expect(pagination.getByRole("button",{name:"上一页",exact:true})).toBeDisabled();
  await pagination.getByRole("button",{name:"下一页",exact:true}).click();await pagination.getByRole("button",{name:"下一页",exact:true}).click();await expect(pagination).toContainText("第 3 / 3 页");await expect(list.locator("article")).toHaveCount(1);await expect(pagination.getByRole("button",{name:"下一页",exact:true})).toBeDisabled();
  await list.getByRole("button",{name:/^删除备份：/}).click();const dialog=page.getByRole("dialog",{name:"删除本地备份",exact:true});await expect(dialog).toContainText("当前笔记、附件及其他保留备份不受影响");await dialog.getByRole("button",{name:"取消",exact:true}).click();expect(await page.evaluate(()=>(window as any).__offlineTest.calls.filter((call:any)=>call.method==="delete"))).toEqual([]);
  await list.getByRole("button",{name:/^删除备份：/}).click();await dialog.getByRole("button",{name:"删除备份",exact:true}).click();await expect(dialog).toHaveCount(0);await expect(pagination).toContainText("共 20 份 · 第 2 / 2 页");await expect(list.locator("article")).toHaveCount(10);expect(await page.evaluate(()=>(window as any).__offlineTest.calls.filter((call:any)=>call.method==="delete"))).toEqual([{method:"delete",id:"history-20"}]);await expect(page.getByText("本地备份已删除，当前笔记与其他备份已保留",{exact:true})).toBeVisible();
  await pagination.getByRole("button",{name:"上一页",exact:true}).click();await expect(pagination).toContainText("第 1 / 2 页");
});

test("最新和唯一备份有明确确认提示，失败可重试，删除过程中阻止重复操作",async({page})=>{
  await mount(page);await backupHistory(page,2);const list=page.getByLabel("本地备份列表",{exact:true}),dialog=page.getByRole("dialog",{name:"删除本地备份",exact:true});
  await list.getByRole("button",{name:/^删除备份：/}).first().click();await expect(dialog).toContainText("这是最新的本地备份");await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
  await backupHistory(page,1);await list.getByRole("button",{name:/^删除备份：/}).click();await expect(dialog).toContainText("这是当前账号唯一的本地备份");await page.evaluate(()=>(window as any).__offlineTest.failDelete(true));await dialog.getByRole("button",{name:"删除备份",exact:true}).click();await expect(page.getByRole("alert")).toHaveText("备份删除失败，请重试");await expect(dialog.getByRole("button",{name:"删除备份",exact:true})).toBeEnabled();await expect(list.locator("article")).toHaveCount(1);
  await page.evaluate(()=>{(window as any).__offlineTest.failDelete(false);(window as any).__offlineTest.deferDelete();});await dialog.getByRole("button",{name:"删除备份",exact:true}).click();await expect(dialog.getByRole("button",{name:"正在删除…",exact:true})).toBeDisabled();await expect(dialog.getByRole("button",{name:"取消",exact:true})).toBeDisabled();await page.keyboard.press("Escape");await expect(dialog).toBeVisible();await page.evaluate(()=>(window as any).__offlineTest.completeDelete());await expect(dialog).toHaveCount(0);await expect(list.locator("article")).toHaveCount(0);await expect(page.getByRole("navigation",{name:"本地备份分页",exact:true})).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__offlineTest.calls.filter((call:any)=>call.method==="delete"))).toHaveLength(2);
});

test("后台清理或切换备份目录后页码有效，恢复迁移更新期间禁用备份删除",async({page})=>{
  await mount(page);await backupHistory(page,21);const pagination=page.getByRole("navigation",{name:"本地备份分页",exact:true});await pagination.getByRole("button",{name:"下一页",exact:true}).click();await pagination.getByRole("button",{name:"下一页",exact:true}).click();await backupHistory(page,2);await expect(pagination).toContainText("共 2 份 · 第 1 / 1 页");
  const remove=page.getByLabel("本地备份列表",{exact:true}).getByRole("button",{name:/^删除备份：/}).first();
  for(const patch of [{backupRestoring:true},{storageMigrating:true},{workspaceSwitching:true},{backupBusy:true},{updates:{status:"installing"}}]){
    await page.evaluate(value=>(window as any).__offlineTest.state({backupRestoring:false,storageMigrating:false,workspaceSwitching:false,backupBusy:false,updates:undefined,...value}),patch);await expect(remove).toBeDisabled();
  }
  await page.evaluate(()=>(window as any).__offlineTest.state({updates:undefined}));await expect(remove).toBeEnabled();await backupHistory(page,21);await pagination.getByRole("button",{name:"下一页",exact:true}).click();await page.evaluate(()=>(window as any).__offlineTest.emit({config:{enabled:false,scope:"all-readable",libraryIds:[],includeAssets:true,backupDirectory:"/test/new-location",retention:10,backupIntervalMinutes:0}}));await expect(pagination).toContainText("第 1 / 3 页");
});

import {test,expect,type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import * as Y from "yjs";
import {api,admin,login} from "./helpers";
async function person(request:APIRequestContext,root:any){const username="save-"+randomUUID().slice(0,8),password="Save-shortcut-test-123!";await api(request,"POST","users",{username,password,name:username},root);return {...await api(request,"POST","auth/login",{username,password}),username,password};}
async function setup(request:APIRequestContext){const root=await admin(request),owner=await person(request,root),book=await api(request,"POST","spaces",{kind:"personal",name:"手动保存"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"保存前"},owner);return {root,owner,book,note};}
async function watchKeys(page:any){await page.addInitScript(()=>{(window as any).saveKeys=[];window.addEventListener("keydown",event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s")setTimeout(()=>(window as any).saveKeys.push({prevented:event.defaultPrevented,ctrl:event.ctrlKey,meta:event.metaKey}),0);},true);});}

test("Ctrl/Command+S 拦截网页保存，立即提交正文与未失焦标题，不重复生成历史",async({page,request})=>{
  const {owner,note}=await setup(request),db=new Pool({host:"db",user:"anote",database:"anote",password:process.env.DB_PASSWORD});
  await watchKeys(page);await login(page,owner);await page.goto("/?doc="+note.id);
  try{
    const editor=page.getByTestId("editor"),status=page.getByTestId("document-sync");await editor.locator("p").first().click();await page.keyboard.insertText("按快捷键立即落库的正文");
    const saved=page.waitForResponse(r=>r.url().endsWith(`/documents/${note.id}/save`)&&r.request().method()==="POST");await page.keyboard.press("Control+s");expect((await saved).status()).toBe(201);await expect(status).toHaveText("已保存");
    expect(JSON.stringify((await db.query("SELECT snapshot FROM documents WHERE id=$1",[note.id])).rows[0].snapshot)).toContain("按快捷键立即落库的正文");
    const title=page.getByLabel("笔记标题",{exact:true});await title.fill("未失焦也能保存的标题");await title.press("Meta+s");await expect(status).toHaveText("已保存");expect(await title.evaluate(el=>document.activeElement===el)).toBe(true);
    expect((await db.query("SELECT title FROM documents WHERE id=$1",[note.id])).rows[0].title).toBe("未失焦也能保存的标题");
    for(let i=0;i<3;i++){await title.press("Control+s");await expect(status).toHaveText("已保存");}
    expect((await api(request,"GET",`documents/${note.id}/versions`,undefined,owner)).length).toBe(1);
    await expect.poll(()=>page.evaluate(()=>(window as any).saveKeys.length)).toBe(5);expect(await page.evaluate(()=>(window as any).saveKeys.every((e:any)=>e.prevented))).toBe(true);
    await page.reload();await expect(title).toHaveValue("未失焦也能保存的标题");await expect(editor).toContainText("按快捷键立即落库的正文");
    // Unrelated forms and home pages retain their own shortcut scope.
    await page.locator(".academic-user").getByRole("button",{name:"设置",exact:true}).click();expect(await page.getByLabel("昵称",{exact:true}).evaluate(el=>el.dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,bubbles:true,cancelable:true})))).toBe(true);await page.keyboard.press("Escape");
    await page.locator(".academic-navigation").getByRole("button",{name:"首页",exact:true}).click();expect(await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,cancelable:true})))).toBe(true);
  }finally{await db.end();}
});

test("保存失败可重试，连续按键只提交一次，输入法合成期间不提交半成品",async({page,request})=>{
  const {owner,note}=await setup(request);await login(page,owner);await page.goto("/?doc="+note.id);const editor=page.getByTestId("editor"),status=page.getByTestId("document-sync");await editor.locator("p").first().click();await page.keyboard.insertText("保留失败时的草稿");
  let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/documents/${note.id}/save`,async route=>{calls++;await gate;await route.fulfill({status:503,json:{error:"测试中的临时故障"}});});
  await page.keyboard.press("Control+s");await expect.poll(()=>calls).toBe(1);await page.keyboard.press("Control+s");await page.keyboard.press("Meta+s");expect(calls).toBe(1);await expect(status).toHaveText("正在保存…");release();
  await expect(status).toHaveText("保存未完成");await expect(page.locator(".note-error")).toContainText("正文已缓存到本机");await expect(editor).toContainText("保留失败时的草稿");await page.unroute(`**/documents/${note.id}/save`);
  await page.keyboard.press("Control+s");await expect(status).toHaveText("已保存");await expect(page.locator(".note-error")).toHaveCount(0);
  const title=page.getByLabel("笔记标题",{exact:true});await page.route(`**/documents/${note.id}`,route=>route.request().method()==="PATCH"?route.fulfill({status:503,json:{error:"标题临时故障"}}):route.continue());await title.fill("标题失败后重试");await title.press("Control+s");await expect(status).toHaveText("保存未完成");await page.unroute(`**/documents/${note.id}`);await title.press("Control+s");await expect(status).toHaveText("已保存");
  expect((await api(request,"GET",`documents/${note.id}`,undefined,owner)).title).toBe("标题失败后重试");
  expect(await editor.evaluate(el=>el.dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,isComposing:true,bubbles:true,cancelable:true})))).toBe(false);await expect(status).toHaveText("请先完成当前输入，再保存");
});

test("断网明确提示本机缓存；只读与归档笔记不越权保存",async({page,request})=>{
  const {root,owner,note}=await setup(request);await login(page,owner);await page.goto("/?doc="+note.id);const editor=page.getByTestId("editor"),status=page.getByTestId("document-sync");await expect(editor).toBeVisible();await page.context().setOffline(true);await editor.locator("p").first().click();await page.keyboard.insertText("断网后的正文");await page.keyboard.press("Control+s");await expect(status).toHaveText("正文已缓存到本机，尚未同步到服务器");
  const updates=await page.evaluate(async({owner,id})=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(`anote:${location.origin}:${owner}:${id}`);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise<number[][]>((resolve,reject)=>{const r=db.transaction("updates").objectStore("updates").getAll();r.onsuccess=()=>resolve(r.result.map((a:Uint8Array)=>Array.from(a)));r.onerror=()=>reject(r.error);});}finally{db.close();}},{owner:owner.user.id,id:note.id});const cached=new Y.Doc();try{for(const update of updates)Y.applyUpdate(cached,new Uint8Array(update));expect(cached.getXmlFragment("default").toString()).toContain("断网后的正文");}finally{cached.destroy();}
  await page.context().setOffline(false);await expect(status).not.toHaveText("等待连接");
  const team=await api(request,"POST","teams",{name:"只读保存"},root),book=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"只读资料"},root);await api(request,"POST",`spaces/${book.id}/members`,{user_id:owner.user.id,role:"viewer"},root);const shared=await api(request,"POST","documents",{space_id:book.id,title:"他人的笔记"},root);
  await api(request,"POST",`documents/${shared.id}/save`,undefined,owner,403);await page.goto("/?doc="+shared.id);await expect(editor).toHaveAttribute("contenteditable","false");let calls=0;page.on("request",r=>{if(r.url().endsWith("/save"))calls++;});await page.keyboard.press("Meta+s");await expect(status).toHaveText("当前为只读笔记，无需保存");expect(calls).toBe(0);
  await api(request,"PATCH",`documents/${note.id}`,{archived:true},owner);await api(request,"POST",`documents/${note.id}/save`,undefined,owner,409);await page.goto("/?doc="+note.id);await expect(editor).toHaveAttribute("contenteditable","false");await page.keyboard.press("Control+s");await expect(status).toHaveText("当前为只读笔记，无需保存");expect(calls).toBe(0);
});

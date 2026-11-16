import {test,expect,type APIRequestContext,type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin,login} from "./helpers";
import {exportNodes} from "./note-export.fixture";
async function setup(page:Page,request:APIRequestContext,rich=true){const root=await admin(request),username="export-"+randomUUID().slice(0,8),password="Export-note-test-123!";await api(request,"POST","users",{username,password,name:"导出作者"},root);const owner={...await api(request,"POST","auth/login",{username,password}),username,password},book=await api(request,"POST","spaces",{kind:"personal",name:"文档导出"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"论文与研究记录"},owner);await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable","true");await page.getByTestId("editor").evaluate((el,content)=>(el as any).editor.commands.setContent({type:"doc",content}),rich?exportNodes():[{type:"paragraph",content:[{type:"text",text:"文件名回归正文"}]}]);if(rich){await expect(page.locator(".mermaid-stage iframe")).toHaveCount(1);await page.getByLabel("上传附件文件",{exact:true}).setInputFiles("artifacts/server/fixtures/sample.png");await expect(page.locator(".media-resource img")).toHaveJSProperty("naturalWidth",64);}await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存");return {owner,book,note};}
async function menu(page:Page,name:string){await page.getByRole("button",{name:"笔记更多操作",exact:true}).click();await expect(page.getByRole("button",{name:/导出 Word/})).toHaveCount(0);await page.getByRole("button",{name,exact:true}).click();}
async function capturePrint(page:Page){
  await page.addInitScript(()=>{
    window.print=function(){
      if(!window.frameElement?.hasAttribute("data-note-print"))return;
      const parent=window.parent as any;
      parent.__anotePrinted=true;
      (parent.__notePrintCalls||=[]).push({parentTitle:window.parent.document.title,frameTitle:document.title});
      if(parent.__notePrintFailure)throw new Error("模拟打印失败");
    };
  });
}
async function finishPrint(page:Page){
  await page.locator('iframe[data-note-print="true"]').evaluate(frame=>(frame as HTMLIFrameElement).contentWindow!.dispatchEvent(new Event("afterprint")));
  await expect(page.locator('iframe[data-note-print="true"]')).toHaveCount(0);
}
test("浏览器 PDF 使用独立 A4 打印页，去掉交互控件，图片图表嵌入且正文注入不执行",async({page,request})=>{
  await capturePrint(page);const f=await setup(page,request),platformTitle=await page.title(),before=(await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).hash;await menu(page,"打印／保存 PDF");await expect.poll(()=>page.evaluate(()=>(window as any).__anotePrinted)).toBe(true);expect(await page.evaluate(()=>(window as any).__notePrintCalls)).toEqual([{parentTitle:"论文与研究记录",frameTitle:"论文与研究记录"}]);const frame=page.frameLocator('iframe[data-note-print="true"]');await expect(frame.locator("h1.export-title")).toHaveText("论文与研究记录");await expect(frame.locator("body")).toContainText("实验结论");await expect(frame.locator("body")).toContainText("已经完成的任务");await expect(frame.locator("math")).toHaveCount(1);await expect(frame.locator("img.diagram")).toHaveCount(2);await expect(frame.locator("script,button,input,iframe,aside")).toHaveCount(0);await expect(frame.locator("table th")).toHaveAttribute("colspan","2");expect(await frame.locator("style").textContent()).toContain("size:A4");expect(await frame.locator("body").evaluate(()=>(window as any).__exportInjection)).toBeUndefined();await finishPrint(page);await expect(page).toHaveTitle(platformTitle);expect((await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).hash).toBe(before);
});

test("PDF 文件名跟随中文笔记标题，清理非法字符；取消、连续导出与打印失败后恢复平台标题",async({page,request})=>{
  await capturePrint(page);
  const f=await setup(page,request,false),platformTitle=await page.title();
  const names=[{title:"中文/研究:第1版?",filename:"中文_研究_第1版_"},{title:"第二篇研究记录",filename:"第二篇研究记录"},{title:"研究  记录",filename:"研究 记录"}];
  for(let index=0;index<names.length;index++){
    const name=names[index];
    await page.getByLabel("笔记标题",{exact:true}).fill(name.title);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByTestId("document-sync")).toHaveText("已保存");
    const before=(await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).hash;
    await menu(page,"打印／保存 PDF");
    await expect.poll(()=>page.evaluate(()=>(window as any).__notePrintCalls?.length||0)).toBe(index+1);
    expect(await page.evaluate(()=>(window as any).__notePrintCalls.at(-1))).toEqual({parentTitle:name.filename,frameTitle:name.filename});
    await expect(page.frameLocator('iframe[data-note-print="true"]').locator("h1.export-title")).toHaveText(name.title);
    // Browsers emit afterprint when printing finishes or the dialog is cancelled.
    await finishPrint(page);
    await expect(page).toHaveTitle(platformTitle);
    expect((await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).hash).toBe(before);
  }
  const before=(await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).hash;
  await page.evaluate(()=>(window as any).__notePrintFailure=true);
  await menu(page,"打印／保存 PDF");
  await expect.poll(()=>page.evaluate(()=>(window as any).__notePrintCalls?.length||0)).toBe(names.length+1);
  await expect(page.locator('iframe[data-note-print="true"]')).toHaveCount(0);
  await expect(page).toHaveTitle(platformTitle);
  expect((await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).hash).toBe(before);
});

test("修改标题尚未保存时按当前标题导出，打印期间焦点刷新不覆盖文件名",async({page,request})=>{
  await capturePrint(page);
  const f=await setup(page,request,false),platformTitle=await page.title(),draft="刚修改/尚未保存";
  let release!:()=>void,requested=false;
  const saving=new Promise<void>(resolve=>release=resolve),pattern="**/api/documents/"+f.note.id;
  await page.route(pattern,async route=>{
    if(route.request().method()==="PATCH"&&route.request().postDataJSON()?.title===draft){requested=true;await saving;}
    await route.continue();
  });
  try{
    await page.getByLabel("笔记标题",{exact:true}).fill(draft);
    await page.getByLabel("笔记标题",{exact:true}).press("Tab");
    await expect.poll(()=>requested).toBe(true);
    const before=await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner);
    expect(before.title).toBe(f.note.title);
    await menu(page,"打印／保存 PDF");
    await expect.poll(()=>page.evaluate(()=>(window as any).__notePrintCalls?.length||0)).toBe(1);
    expect(await page.evaluate(()=>(window as any).__notePrintCalls[0])).toEqual({parentTitle:"刚修改_尚未保存",frameTitle:"刚修改_尚未保存"});
    await expect(page.frameLocator('iframe[data-note-print="true"]').locator("h1.export-title")).toHaveText(draft);
    const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/platform/public");
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await refreshed;
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(page).toHaveTitle("刚修改_尚未保存");
    await finishPrint(page);
    await expect(page).toHaveTitle(platformTitle);
    expect((await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).hash).toBe(before.hash);
    release();
    await expect.poll(async()=>(await api(request,"GET",`documents/${f.note.id}`,undefined,f.owner)).title).toBe(draft);
  }finally{release();await page.unroute(pattern);}
});

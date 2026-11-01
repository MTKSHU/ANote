import {test,expect,type Page,type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api,admin,login,slash,chooseTheme} from "./helpers";
import {person,grant,connect,call} from "./mcp-helpers";
async function setup(page:Page,request:APIRequestContext){const owner=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"十月编辑器验证"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"交互验证"},owner);await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable","true");return {owner,book,note};}
async function content(page:Page,value:any){await page.getByTestId("editor").evaluate((element,json)=>(element as any).editor.commands.setContent(json),value);}
const p=(text:string)=>({type:"paragraph",content:[{type:"text",text}]});

test("TODO 输入、阅读勾选、重新加载和只读权限；Markdown 导出与实时协作同步",async({page,request,browser})=>{
  const{owner,note}=await setup(page,request);
  await page.getByTestId("editor").click();await page.keyboard.type("- [ ] ");await page.keyboard.insertText("第一项任务");
  await expect(page.locator('ul[data-type="taskList"]')).toHaveCount(1);await expect(page.getByTestId("editor").locator(":scope > ul")).toHaveAttribute("data-type","taskList");
  const checkbox=page.getByRole("checkbox",{name:"待办：第一项任务"});await expect(checkbox).not.toBeChecked();
  await page.keyboard.press('Enter');await page.keyboard.press('Tab');await page.keyboard.insertText('子任务');
  const child=page.getByRole('checkbox',{name:'待办：子任务',exact:true});
  await page.locator(".document-actions").getByRole("button",{name:"阅读",exact:true}).click();await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable","false");await checkbox.check();await expect(checkbox).toBeChecked();
  await child.check();await expect(child).toBeChecked();await expect(checkbox).toBeChecked();await child.uncheck();await expect(checkbox).toBeChecked();
  await expect.poll(async()=>JSON.stringify((await api(request,"GET",`documents/${note.id}`,undefined,owner)).snapshot)).toContain('"checked":true');
  expect((await api(request,"GET",`documents/${note.id}/export`,undefined,owner)).markdown).toContain("- [x] 第一项任务");
  const peer=await person(request),sharing=await api(request,"GET",`documents/${note.id}/sharing`,undefined,owner);await api(request,"PATCH",`documents/${note.id}/sharing`,{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:peer.user.id,role:"viewer"}]},owner);
  const other=await browser.newContext();try{const view=await other.newPage();await login(view,peer);await view.goto("/?doc="+note.id);await expect(view.getByRole("checkbox",{name:"待办：第一项任务"})).toBeDisabled();await checkbox.uncheck();await expect(view.getByRole("checkbox",{name:"待办：第一项任务"})).not.toBeChecked();}finally{await other.close();}
  await page.reload();await expect(checkbox).not.toBeChecked();
});

test("斜线仅在段落开头呼出；每个表格单元格独立，右键保留浏览器菜单",async({page,request})=>{
  await setup(page,request);await page.getByTestId("editor").click();await page.keyboard.insertText("已有内容/");await expect(page.getByRole("listbox",{name:"插入内容"})).toHaveCount(0);
  await page.keyboard.press("Enter");await page.keyboard.insertText("/");await expect(page.getByRole("listbox",{name:"插入内容"})).toBeVisible();await page.keyboard.press("Escape");
  await content(page,{type:"doc",content:[{type:"table",content:[{type:"tableRow",content:[{type:"tableCell",content:[p("已有内容")]},{type:"tableCell",content:[{type:"paragraph"}]},{type:"tableCell",content:[{type:"paragraph"}]}]}]}]});
  await page.locator(".research-editor td").nth(1).locator("p").click();await page.keyboard.insertText("/");await expect(page.getByRole("listbox",{name:"插入内容"})).toBeVisible();await page.keyboard.press("Escape");
  const prevented=await page.getByTestId("editor").evaluate(element=>{const event=new MouseEvent("contextmenu",{bubbles:true,cancelable:true});element.dispatchEvent(event);return event.defaultPrevented;});expect(prevented).toBe(false);
});

test("思维导图使用节点边缘贝塞尔曲线，Tab 子节点、Enter 同级、组合输入不误触",async({page,request})=>{
  await setup(page,request);await slash(page,"思维导图");const map=page.getByTestId("mind-map");const inputs=map.locator('.mind-map-node input');await map.locator(".mind-map-node").first().click();await page.keyboard.press("Tab");await expect(map.locator(".mind-map-node")).toHaveCount(2);await expect(inputs).toBeFocused();await page.keyboard.insertText("实验一");await page.keyboard.press("Enter");await expect(map.locator(".mind-map-node")).toHaveCount(3);await expect(inputs).toBeFocused();
  const nodes=await page.getByTestId("editor").evaluate(element=>(element as any).editor.getJSON().content.find((n:any)=>n.type==="mindMap").content);expect(nodes[1].attrs.parentId).toBe(nodes[2].attrs.parentId);expect(nodes[1].attrs.y).not.toBe(nodes[2].attrs.y);
  await expect(map.locator(".mind-map-edges > path").first()).toHaveAttribute("d",/C /);
  await inputs.dispatchEvent("keydown",{key:"Enter",isComposing:true});await expect(map.locator(".mind-map-node")).toHaveCount(3);
  await page.screenshot({path:"artifacts/web/oct31-mind-map.png"});
});

test("双图区域直接拖动、键盘微调且不复制图片，阅读时可比较但不改正式内容",async({page,request})=>{
  const{owner,note}=await setup(page,request);await slash(page,"双图对比");await page.getByLabel("上传附件文件",{exact:true}).setInputFiles(["artifacts/server/fixtures/sample.png","artifacts/server/fixtures/wide.png"]);
  const comparison=page.getByTestId("image-comparison"),slider=comparison.getByRole("slider",{name:"对比位置"});await expect(slider).toBeVisible();await expect(page.getByRole("button",{name:"平铺对比"})).toHaveCount(0);
  await comparison.locator('img').evaluateAll(async images=>{await Promise.all(images.map(image=>(image as HTMLImageElement).decode()));await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
  await slider.evaluate(el=>el.addEventListener('pointerup',event=>{const r=el.getBoundingClientRect();(window as any).__dragExpected=Math.round(((event as PointerEvent).clientX-r.left)/r.width*100);},true));
  const bounds=await slider.boundingBox();await page.mouse.move(bounds!.x+bounds!.width*.2,bounds!.y+bounds!.height*.4);await page.mouse.down();await page.mouse.move(bounds!.x+bounds!.width*.8,bounds!.y+bounds!.height*.4,{steps:12});const settled=await slider.boundingBox();await page.mouse.move(settled!.x+settled!.width*.8,settled!.y+settled!.height*.4);await page.mouse.up();const dragExpected=await page.evaluate(()=>(window as any).__dragExpected);expect(dragExpected).toBeGreaterThan(70);expect(dragExpected).toBeLessThan(85);await expect(slider).toHaveAttribute("aria-valuenow",String(dragExpected));
  const disabled=await comparison.locator("img").first().evaluate(image=>{const e=new Event("dragstart",{bubbles:true,cancelable:true});image.dispatchEvent(e);return e.defaultPrevented;});expect(disabled).toBe(true);await expect(page.locator(".media-resource")).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');const before=(await api(request,"GET",`documents/${note.id}`,undefined,owner)).hash;await page.locator(".document-actions").getByRole("button",{name:"阅读",exact:true}).click();await slider.focus();await page.keyboard.press("ArrowLeft");await expect(slider).toHaveAttribute("aria-valuenow",String(dragExpected-2));expect((await api(request,"GET",`documents/${note.id}`,undefined,owner)).hash).toBe(before);
});

test("自动历史单行与命名版本分栏，保存版本号和说明；明暗主题与共享按钮一致",async({page,request})=>{
  const{owner,note}=await setup(page,request);await content(page,{type:"doc",content:[p("版本内容")]});await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存");await page.locator(".document-actions").getByRole("button",{name:"历史版本",exact:true}).click();
  const panel=page.getByRole("complementary",{name:"历史版本",exact:true});await expect(panel.locator(".history-row")).toBeVisible();await expect(panel.locator(".history-named")).toHaveCount(0);await panel.getByRole("tab",{name:"命名版本",exact:true}).click();await page.getByLabel("版本号",{exact:true}).fill("v1.0");await page.getByLabel("版本说明",{exact:true}).fill("实验初稿");await page.getByRole("button",{name:"保存当前版本",exact:true}).click();await expect(panel.locator(".history-named")).toContainText("v1.0");await expect(panel.locator(".history-named")).toContainText("实验初稿");
  expect((await api(request,"GET",`documents/${note.id}/versions`,undefined,owner))[0].version_name).toBe("v1.0");
  for(const theme of ["light","dark"] as const){await chooseTheme(page,theme);await expect(page.locator('html')).not.toHaveClass(/theme-changing/);await page.screenshot({path:`artifacts/web/oct31-history-${theme}.png`});const styles=await page.locator(".document-actions").evaluate(el=>[...el.querySelectorAll('button')].filter(b=>["阅读","评论","历史版本","共享"].includes(b.textContent!.trim())).map(b=>getComputedStyle(b).borderWidth));expect(new Set(styles)).toEqual(new Set(["0px"]));}
});

test("组合输入跨越同步、历史轮询仍保留 DOM、焦点和预编辑文本",async({page,request})=>{
  const{owner,note}=await setup(page,request);const editor=page.getByTestId("editor");await editor.click();await editor.evaluate(element=>{(window as any).__imeNode=element;(window as any).__imeEditor=(element as any).editor;});await editor.dispatchEvent("compositionstart",{data:""});
  await editor.evaluate(element=>{const e=(element as any).editor;e.view.dispatch(e.state.tr.insertText("shuru"));});
  await expect.poll(async()=>JSON.stringify((await api(request,"GET",`documents/${note.id}`,undefined,owner)).snapshot)).toContain("shuru");
  const db=new Pool({host:"db",database:"anote",user:"anote",password:process.env.DB_PASSWORD});try{await db.query("UPDATE document_versions SET created_at=now()-interval '61 seconds' WHERE doc_id=$1",[note.id]);await api(request,"POST",`documents/${note.id}/save`,{},owner);}finally{await db.end();}
  // A real history poll and provider acknowledgement cause React updates while composing.
  await page.waitForResponse(response=>response.url().endsWith(`/documents/${note.id}/versions`));
  expect(await editor.evaluate(el=>el===(window as any).__imeNode&&(el as any).editor===(window as any).__imeEditor)).toBe(true);await expect(editor).toBeFocused();await expect(editor).toContainText("shuru");await expect(editor).toHaveAttribute("data-composing","true");
  await editor.dispatchEvent("compositionend",{data:"输入"});await editor.evaluate(element=>{const e=(element as any).editor;let textPos=0;e.state.doc.descendants((n:any,pos:number)=>{if(n.isText&&n.text==="shuru")textPos=pos;});e.view.dispatch(e.state.tr.insertText("输入",textPos,textPos+5));});await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存");expect(JSON.stringify((await api(request,"GET",`documents/${note.id}`,undefined,owner)).snapshot)).toContain("输入");
});

test("图片全视口预览支持缩放、拖动、右键与 Esc，视频和 PDF 直接查看",async({page,request})=>{
  await setup(page,request);await page.getByLabel("上传附件文件",{exact:true}).setInputFiles("artifacts/server/fixtures/sample.png");const image=page.locator(".media-resource img");await expect(image).toHaveJSProperty("naturalWidth",64);await image.dblclick();const viewer=page.getByRole("dialog",{name:"媒体预览",exact:true});await expect(viewer).toBeVisible();const r=await viewer.boundingBox(),viewport=page.viewportSize()!;expect(r!.width).toBe(viewport.width);expect(r!.height).toBe(viewport.height);await expect(viewer.getByLabel("附件标题")).toHaveCount(0);await viewer.getByRole("button",{name:"放大图片",exact:true}).click();await expect(viewer.locator(".media-lightbox-stage")).toHaveAttribute("data-zoom","1.25");
  const box=await viewer.locator("img").boundingBox();await page.mouse.move(viewport.width/2,viewport.height/2);await page.mouse.down();await page.mouse.move(viewport.width/2+80,viewport.height/2+45);await page.mouse.up();await expect(viewer.locator(".media-lightbox-stage")).toHaveAttribute("data-pan-x","80");
  expect(await viewer.locator("img").evaluate(el=>{const e=new MouseEvent("contextmenu",{bubbles:true,cancelable:true});el.dispatchEvent(e);return e.defaultPrevented;})).toBe(false);await page.mouse.wheel(0,-100);await expect.poll(async()=>Number(await viewer.locator('.media-lightbox-stage').getAttribute('data-zoom'))).toBeGreaterThan(1.25);await page.screenshot({path:"artifacts/web/oct31-image-viewer.png"});await page.keyboard.press("Escape");await expect(viewer).toHaveCount(0);
  await page.getByLabel("上传附件文件",{exact:true}).setInputFiles("artifacts/server/fixtures/sample.mp4");await page.getByRole("button",{name:"放大预览视频",exact:true}).click();await expect(viewer.locator("video")).toHaveJSProperty("controls",true);await viewer.getByRole("button",{name:"视频全屏",exact:true}).click();await expect.poll(()=>page.evaluate(()=>document.fullscreenElement?.tagName)).toBe('VIDEO');await page.evaluate(()=>document.exitFullscreen());await page.keyboard.press("Escape");
  await page.getByLabel('上传附件文件',{exact:true}).setInputFiles('artifacts/server/fixtures/sample.wav');await page.getByRole('button',{name:'放大预览音频',exact:true}).click();await expect(viewer.locator('audio')).toHaveJSProperty('controls',true);await page.keyboard.press('Escape');
  await page.getByLabel("上传附件文件",{exact:true}).setInputFiles({name:"paper.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.4\n1 0 obj <</Type/Catalog>> endobj\n%%EOF")});await page.getByRole("link",{name:"打开附件 paper.pdf",exact:true}).click();const pdf=page.getByRole("dialog",{name:"附件预览",exact:true});await expect(pdf.locator('iframe[title="PDF 文档"]')).toBeVisible();await expect(pdf.getByLabel("附件标题")).toHaveCount(0);await page.keyboard.press("Escape");
});

test("字体 CSP 与站点图标正常，Codex 入口说明和无 Bearer 的配置可复制",async({page,request})=>{
  await setup(page,request);const head=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");expect(head).toContain("font-src 'self' data:");const icon=await request.get("/favicon.ico");expect(icon.status()).toBe(200);expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  await page.locator(".academic-user").getByRole("button",{name:"设置",exact:true}).click();const settings=page.getByRole("dialog",{name:"设置",exact:true});await settings.getByRole("button",{name:"AI工具链",exact:true}).click();await expect(settings).toContainText("Bearer 令牌、标头和环境变量留空");await settings.getByRole("button",{name:"复制 Codex 配置",exact:true}).click();await expect(settings.getByRole("status")).toHaveText("Codex 配置已复制");
});

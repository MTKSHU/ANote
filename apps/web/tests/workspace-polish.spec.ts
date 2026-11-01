import {test,expect,type APIRequestContext,type Page,type Locator} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin,login,chooseTheme,typeBody,slash} from "./helpers";

async function setup(page:Page,request:APIRequestContext,teamMode=false){
  const root=await admin(request),username="polish-"+randomUUID().slice(0,8),password="Workspace-polish-test-123!";
  await api(request,"POST","users",{username,password,name:"界面验证"},root);
  const owner={...await api(request,"POST","auth/login",{username,password}),username,password};
  const team=teamMode?await api(request,"POST","teams",{name:"界面验证团队"},owner):null;
  if(team)await api(request,"PATCH",`teams/${team.id}`,{allow_external_sharing:true},owner);
  const book=await api(request,"POST","spaces",{kind:team?"team":"personal",team_id:team?.id,name:"界面验证知识库"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"待删除笔记"},owner);
  await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toBeVisible();return{root,owner,book,note};
}
async function readable(locator:Locator){
  const ratios=await locator.evaluateAll(elements=>elements.map(element=>{
    const rgb=(value:string)=>(value.match(/[\d.]+/g)||[]).map(Number);let bg=[255,255,255];
    for(let node:Element|null=element;node;node=node.parentElement){const value=rgb(getComputedStyle(node).backgroundColor);if(value.length===3||value[3]===1){bg=value;break;}}
    const lum=(value:number[])=>value.slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const foreground=getComputedStyle(element).color,fg=lum(rgb(foreground)),back=lum(bg);return{text:element.textContent?.trim().slice(0,60),foreground,background:bg,ratio:(Math.max(fg,back)+.05)/(Math.min(fg,back)+.05)};
  }));expect(ratios.length).toBeGreaterThan(0);for(const value of ratios)expect(value.ratio,JSON.stringify(value)).toBeGreaterThanOrEqual(4.5);
}

test("分享弹窗完整适配明暗主题，权限成员、外链和滚动内容均可读",async({page,request})=>{
  const{root,owner,book}=await setup(page,request,true),person=await api(request,"POST","users",{username:"share-"+randomUUID().slice(0,8),password:"Share-contrast-test-123!",name:"对比成员"},root);
  await api(request,"POST",`spaces/${book.id}/members`,{user_id:person.id,role:"viewer"},owner);
  for(const theme of ["light","dark"] as const){
    await chooseTheme(page,theme);await expect(page.locator("html")).not.toHaveClass(/theme-changing/);await page.getByRole("button",{name:"共享",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"分享笔记",exact:true}),body=dialog.locator(".dialog-body");await expect(dialog.getByRole("button",{name:"保存权限",exact:true})).toBeVisible();
    if(theme==="light"){await dialog.getByLabel("邀请成员",{exact:true}).selectOption(person.id);await dialog.getByLabel("权限 "+person.id,{exact:true}).selectOption("editor");await dialog.getByRole("button",{name:"保存权限",exact:true}).click();await expect(dialog.getByLabel("权限 "+person.id,{exact:true})).toHaveValue("editor");await dialog.getByRole("button",{name:"生成外链",exact:true}).click();await expect(dialog.getByLabel("外部链接",{exact:true})).toHaveValue(/^http/);}
    expect(await body.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor));if(theme==="dark")await expect(body).not.toHaveCSS("background-color","rgb(255, 255, 255)");
    await readable(body.locator("label,h3,p,.collaborator span,.collaborator small,input,select"));
    await body.evaluate(el=>el.scrollTop=el.scrollHeight);await expect(dialog.getByRole("button",{name:"关闭",exact:true})).toBeInViewport();await page.screenshot({path:`artifacts/web/share-dialog-${theme}.png`,animations:"disabled"});await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
  }
});

test("回收站页签隔离三类内容，键盘切换、计数和恢复彻底删除保持正确",async({page,request})=>{
  const{owner,note}=await setup(page,request),book=await api(request,"POST","spaces",{kind:"personal",name:"待删除知识库"},owner),team=await api(request,"POST","teams",{name:"待删除团队"},owner);
  await api(request,"DELETE",`documents/${note.id}`,undefined,owner);await api(request,"DELETE",`spaces/${book.id}`,undefined,owner);await api(request,"DELETE",`teams/${team.id}`,undefined,owner);
  await page.goto("/");await page.locator(".academic-navigation").getByRole("button",{name:/回收站/}).click();const tabs=page.getByRole("tablist",{name:"回收站分类"}),panel=page.getByRole("tabpanel");await expect(panel).toContainText(note.title);
  await expect(tabs.getByRole("tab")).toHaveCount(3);await expect(panel).toHaveCount(1);await expect(tabs.getByRole("tab",{name:/^笔记/})).toHaveAttribute("aria-selected","true");
  for(const theme of ["light","dark"] as const){
    await chooseTheme(page,theme);await expect(page.locator("html")).not.toHaveClass(/theme-changing/);await readable(panel.locator("strong,small,time"));await readable(tabs.getByRole("tab"));await expect(panel).toContainText(note.title);await expect(panel).not.toContainText(book.name);await page.screenshot({path:`artifacts/web/trash-tabs-${theme}.png`,animations:"disabled"});
  }
  await tabs.getByRole("tab",{name:/^笔记/}).focus();await page.keyboard.press("ArrowLeft");await expect(panel).toContainText(book.name);await expect(panel).not.toContainText(note.title);await page.keyboard.press("Home");await expect(panel).toContainText(team.name);await page.keyboard.press("End");await expect(panel).toContainText(note.title);
  await panel.getByRole("button",{name:"恢复笔记 "+note.title,exact:true}).click();await expect(panel.locator(".trash-row")).toHaveCount(0);await expect(tabs.getByRole("tab",{name:/^笔记/})).toContainText("0");
  await tabs.getByRole("tab",{name:/^知识库/}).click();await panel.getByRole("button",{name:"彻底删除知识库 "+book.name,exact:true}).click();const confirm=page.getByRole("dialog",{name:"确认彻底删除"});await confirm.getByLabel("输入名称确认彻底删除",{exact:true}).fill(book.name);await confirm.getByRole("button",{name:"确认彻底删除",exact:true}).click();await expect(confirm).toHaveCount(0);await expect(panel.locator(".trash-row")).toHaveCount(0);
  await tabs.getByRole("tab",{name:/^团队/}).click();await expect(panel).toContainText(team.name);await panel.getByRole("button",{name:"恢复团队 "+team.name,exact:true}).click();await expect(panel.locator(".trash-row")).toHaveCount(0);await api(request,"GET",`documents/${note.id}`,undefined,owner);await api(request,"GET",`teams/${team.id}`,undefined,owner);
});

test("阅读编辑入口在评论左侧，成功提示自动隐藏，失败离线提示持续可见",async({page,request,browser})=>{
  const{root,owner,note}=await setup(page,request),actions=page.locator(".document-actions"),editor=page.getByTestId("editor"),status=page.getByTestId("document-sync");
  expect(await actions.evaluate(el=>{const buttons=[...el.querySelectorAll("button")];return buttons.findIndex(b=>b.textContent?.trim()==="阅读")<buttons.findIndex(b=>b.textContent?.trim()==="评论");})).toBe(true);
  await typeBody(page,"模式切换保留正文。");await page.keyboard.press("Enter");await slash(page,"思维导图");
  await editor.evaluate(el=>{const editor=(el as any).editor;editor.commands.insertContentAt(editor.state.doc.content.size,[{type:"codeBlock",attrs:{language:"python"},content:[{type:"text",text:"print(1)"}]},{type:"mathBlock",attrs:{latex:"X_t"}},{type:"paragraph"}]);});
  await page.keyboard.press("ControlOrMeta+s");await expect(status).toHaveText("已保存");await expect(status).toBeVisible();await page.clock.install();await page.clock.fastForward(2500);await expect(status).toBeHidden();
  await actions.getByRole("button",{name:"阅读",exact:true}).click();await expect(editor).toHaveAttribute("contenteditable","false");await expect(page.getByLabel("笔记标题",{exact:true})).toHaveJSProperty("readOnly",true);await expect(page.getByTestId("mind-map").locator("input")).toHaveCount(0);await page.getByTestId("mind-map").locator(".mind-map-node").first().dblclick();await expect(page.getByTestId("mind-map").locator("input")).toHaveCount(0);await expect(page.getByLabel("代码语言")).toBeDisabled();await expect(page.locator(".editor-block-actions")).toHaveCount(0);await expect(page.locator(".math-render")).not.toHaveAttribute("role","button");await page.keyboard.press("ControlOrMeta+s");await expect(status).toHaveText("当前为只读笔记，无需保存");await expect(status).toBeVisible();
  await actions.getByRole("button",{name:"编辑",exact:true}).click();await expect(editor).toHaveAttribute("contenteditable","true");await expect(page.getByLabel("笔记标题",{exact:true})).toHaveJSProperty("readOnly",false);await page.getByTestId("mind-map").locator(".mind-map-node").first().dblclick();await expect(page.getByTestId("mind-map").locator("input")).toBeEditable();await page.getByTestId("mind-map").locator("input").press("Escape");await expect(page.getByLabel("代码语言")).toBeEnabled();await expect(page.locator(".math-render")).toHaveAttribute("role","button");await actions.getByRole("button",{name:"笔记更多操作",exact:true}).click();await expect(page.locator(".note-more").getByRole("button",{name:/阅读模式|返回编辑/})).toHaveCount(0);await page.keyboard.press("Escape");
  await page.route(`**/api/documents/${note.id}/save`,route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({message:"测试保存失败"})}));await page.keyboard.press("ControlOrMeta+s");await expect(status).toHaveText("保存未完成");await page.clock.fastForward(3000);await expect(status).toBeVisible();await page.unroute(`**/api/documents/${note.id}/save`);
  await page.context().setOffline(true);await editor.locator("p").first().click();await page.keyboard.press("End");await page.keyboard.insertText("离线内容");await page.keyboard.press("ControlOrMeta+s");await expect(status).toHaveText("正文已缓存到本机，尚未同步到服务器");await page.clock.fastForward(3000);await expect(status).toBeVisible();await page.context().setOffline(false);
  const username="view-"+randomUUID().slice(0,8),person=await api(request,"POST","users",{username,password:"Read-mode-test-123!",name:"只读成员"},root),sharing=await api(request,"GET",`documents/${note.id}/sharing`,undefined,owner);await api(request,"PATCH",`documents/${note.id}/sharing`,{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:person.id,role:"viewer"}]},owner);
  const context=await browser.newContext();try{const peer=await context.newPage();await login(peer,{username,password:"Read-mode-test-123!"});await peer.goto("/?doc="+note.id);await expect(peer.getByTestId("editor")).toBeVisible();await expect(peer.locator(".document-actions").getByRole("button",{name:"阅读",exact:true})).toBeDisabled();await expect(peer.getByTestId("editor")).toHaveAttribute("contenteditable","false");}finally{await context.close();}
});

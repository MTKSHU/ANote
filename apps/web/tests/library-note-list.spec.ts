import {test,expect,type APIRequestContext,type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin,login,typeBody,chooseTheme} from "./helpers";

async function person(request:APIRequestContext,root:any) {
  const username="note-list-"+randomUUID().slice(0,8),password="Note-list-test-123!";
  await api(request,"POST","users",{username,password,name:username},root);
  return {...await api(request,"POST","auth/login",{username,password}),username,password};
}
const panel=(page:Page)=>page.getByRole("complementary",{name:"同库笔记",exact:true});

test("笔记列表固定宽度且图标与长短标题靠左，编辑阅读及明暗主题均不改变布局",async({page,request})=>{
  const root=await admin(request),owner=await person(request,root),book=await api(request,"POST","spaces",{kind:"personal",name:"用于验证左对齐和省略号的长知识库名称".repeat(3)},owner);
  const titles=["TODO","这是用于检查固定宽度和省略号的超长笔记标题".repeat(6),"AI视频创作平台调研"],notes=[];
  for(const title of titles)notes.push(await api(request,"POST","documents",{space_id:book.id,title},owner));
  await login(page,owner);await page.goto("/?doc="+notes[0].id);await expect(panel(page).locator('.note-list-item')).toHaveCount(3);
  async function geometry(){
    const result=await panel(page).evaluate(el=>({width:el.getBoundingClientRect().width,icons:[...el.querySelectorAll('.note-list-item>svg')].map(n=>n.getBoundingClientRect().left),texts:[...el.querySelectorAll('.note-list-item>span')].map(n=>({x:n.getBoundingClientRect().left,overflow:n.scrollWidth>n.clientWidth,textAlign:getComputedStyle(n).textAlign})),header:el.querySelector('.note-list-library>span')!.getBoundingClientRect().left}));
    expect(result.width).toBe(208);expect(Math.max(...result.icons)-Math.min(...result.icons)).toBeLessThan(.5);expect(Math.max(...result.texts.map(t=>t.x))-Math.min(...result.texts.map(t=>t.x))).toBeLessThan(.5);expect(result.header).toBeCloseTo(result.icons[0],0);expect(result.texts[1].overflow).toBe(true);for(const text of result.texts)expect(text.textAlign).toBe('left');
  }
  for(const theme of ['light','dark'] as const){await chooseTheme(page,theme);await expect(page.locator('html')).not.toHaveClass(/theme-changing/);
    for(const note of notes){await panel(page).getByRole('button',{name:note.title,exact:true}).click();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(note.title);await geometry();await page.locator('.document-actions').getByRole('button',{name:'阅读',exact:true}).click();await geometry();}
    await panel(page).screenshot({path:`artifacts/web/note-list-alignment-${theme}.png`});
  }
  await expect(panel(page).getByRole('button',{name:titles[1],exact:true})).toHaveAttribute('title',titles[1]);
  for(const width of [1100,900]){await page.setViewportSize({width,height:900});await geometry();}
});

test("编辑页同库笔记按目录顺序显示、直接切换并保存；列表独立收起且重登按账号保留",async({page,request})=>{
  const root=await admin(request),owner=await person(request,root),peer=await person(request,root);
  const book=await api(request,"POST","spaces",{kind:"personal",name:"可切换的知识库"},owner);
  const folder=await api(request,"POST",`spaces/${book.id}/folders`,{name:"实验"},owner);
  const one=await api(request,"POST","documents",{space_id:book.id,title:"目录中的第一篇",folder_id:folder.id},owner);
  const two=await api(request,"POST","documents",{space_id:book.id,title:"根目录第二篇"},owner);
  const three=await api(request,"POST","documents",{space_id:book.id,title:"根目录第三篇"},owner);
  const other=await api(request,"POST","spaces",{kind:"personal",name:"另一本知识库"},owner);
  await api(request,"POST","documents",{space_id:other.id,title:"不属于当前知识库"},owner);
  await login(page,owner);await page.goto("/?doc="+one.id);
  await expect(panel(page).locator(".note-list-item")).toHaveText([one.title,two.title,three.title]);
  await expect(panel(page).locator('[aria-current="page"]')).toHaveText(one.title);
  await typeBody(page,"同库快速切换前的修改。");await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  await panel(page).getByRole("button",{name:two.title,exact:true}).click();
  await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(two.title);
  await expect(panel(page).locator('[aria-current="page"]')).toHaveText(two.title);
  await panel(page).getByRole("button",{name:one.title,exact:true}).click();
  await expect(page.getByTestId("editor")).toContainText("同库快速切换前的修改。");
  await page.getByTestId("editor").evaluate(el=>el.dataset.panelInstance="retained");
  await panel(page).getByRole("button",{name:"隐藏笔记列表",exact:true}).click();
  await expect(page.locator(".academic-sidebar")).toBeVisible();
  await expect(page.getByTestId("editor")).toHaveAttribute("data-panel-instance","retained");
  await page.getByRole("button",{name:"返回知识库",exact:true}).click();
  await page.locator(".note-open").filter({hasText:three.title}).click();
  await expect(panel(page).getByRole("button",{name:"显示笔记列表",exact:true})).toBeVisible();
  await page.reload();await expect(panel(page).getByRole("button",{name:"显示笔记列表",exact:true})).toBeVisible();
  await panel(page).getByRole("button",{name:"显示笔记列表",exact:true}).click();
  await page.getByRole("button",{name:"收起侧边栏",exact:true}).click();
  await panel(page).getByRole("button",{name:two.title,exact:true}).click();
  await expect(page.getByRole("button",{name:"展开侧边栏",exact:true})).toBeVisible();
  await expect(panel(page).getByRole("button",{name:"隐藏笔记列表",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"展开侧边栏",exact:true}).click();await chooseTheme(page,"dark");
  const colors=await panel(page).evaluate(el=>({background:getComputedStyle(el).backgroundColor,foreground:getComputedStyle(el).color}));
  expect(Number(colors.background.match(/\d+/)![0])).toBeLessThan(80);expect(Number(colors.foreground.match(/\d+/)![0])).toBeGreaterThan(180);
  await page.screenshot({path:"artifacts/web/library-note-list-dark.png"});
  await page.setViewportSize({width:700,height:900});
  expect(await page.locator(".academic-main").evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await expect(panel(page).getByRole("button",{name:"隐藏笔记列表",exact:true})).toBeInViewport();
  await panel(page).getByRole("button",{name:"隐藏笔记列表",exact:true}).click();
  await expect(page.getByTestId("editor")).toBeVisible();await page.screenshot({path:"artifacts/web/library-note-list-narrow.png"});
  await page.request.post("/api/auth/logout");await login(page,peer);
  const peers=await api(request,"POST","spaces",{kind:"personal",name:"其他人的知识库"},peer),peerNote=await api(request,"POST","documents",{space_id:peers.id,title:"独立偏好"},peer);
  await page.goto("/?doc="+peerNote.id);await expect(panel(page).getByRole("button",{name:"隐藏笔记列表",exact:true})).toBeVisible();
  await page.request.post("/api/auth/logout");await login(page,owner);await page.goto("/?doc="+one.id);
  await expect(panel(page).getByRole("button",{name:"显示笔记列表",exact:true})).toBeVisible();
});

test("同库列表只显示可读笔记；单篇私有分享不展示作者知识库和其他标题",async({page,request})=>{
  const root=await admin(request),owner=await person(request,root),peer=await person(request,root);
  const team=await api(request,"POST","teams",{name:"列表权限团队"},owner),invite=await api(request,"POST",`teams/${team.id}/invites`,{},owner);
  await api(request,"POST",`team-invitations/${new URL(invite.path,"http://test").searchParams.get("invite")}/accept`,{},peer);
  const book=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"团队可读资料"},owner);
  const a=await api(request,"POST","documents",{space_id:book.id,title:"可读笔记甲"},owner),b=await api(request,"POST","documents",{space_id:book.id,title:"可读笔记乙"},owner);
  await api(request,"POST","documents",{space_id:book.id,title:"未授权的私有标题",visibility:"private"},owner);
  await login(page,peer);await page.goto("/?doc="+a.id);await expect(panel(page).locator(".note-list-item")).toHaveText([a.title,b.title]);
  await panel(page).getByRole("button",{name:b.title,exact:true}).click();await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable","false");
  const personal=await api(request,"POST","spaces",{kind:"personal",name:"不能泄露的私有知识库名"},owner),shared=await api(request,"POST","documents",{space_id:personal.id,title:"单篇分享"},owner);
  await api(request,"POST","documents",{space_id:personal.id,title:"不能泄露的其他私有标题"},owner);
  const sharing=await api(request,"GET",`documents/${shared.id}/sharing`,undefined,owner);
  await api(request,"PATCH",`documents/${shared.id}/sharing`,{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:peer.user.id,role:"viewer"}]},owner);
  await page.goto("/?doc="+shared.id);await expect(page.getByTestId("editor")).toBeVisible();await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".note-workspace")).not.toContainText(personal.name);
});

test("存储受限仍可控制同库列表，收起展开不重建编辑器",async({page,request})=>{
  const root=await admin(request),owner=await person(request,root),book=await api(request,"POST","spaces",{kind:"personal",name:"无存储偏好"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"笔记"},owner);
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(key){if(key.startsWith("anote:note-list-collapsed:"))throw new Error("Unavailable");return get.call(this,key);};Storage.prototype.setItem=function(key,value){if(key.startsWith("anote:note-list-collapsed:"))throw new Error("Unavailable");return set.call(this,key,value);};});
  await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByTestId("editor").evaluate(el=>el.dataset.panelInstance="retained");
  await panel(page).getByRole("button",{name:"隐藏笔记列表",exact:true}).click();await panel(page).getByRole("button",{name:"显示笔记列表",exact:true}).click();
  await expect(page.getByTestId("editor")).toHaveAttribute("data-panel-instance","retained");expect(errors).toEqual([]);
});

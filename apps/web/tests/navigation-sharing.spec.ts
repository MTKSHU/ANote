import {test,expect,type APIRequestContext,type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {admin,api,login,chooseTheme,accountMenu,switchWorkspace} from "./helpers";

async function person(request:APIRequestContext,name="导航用户") {
  const root=await admin(request),username="nav-"+randomUUID().slice(0,8),password="Navigation-fixture-123!";
  await api(request,"POST","users",{username,password,name},root);
  return {...await api(request,"POST","auth/login",{username,password}),username,password};
}
const createBook=(request:APIRequestContext,owner:any,name:string,team?:any)=>api(request,"POST","spaces",{kind:team?"team":"personal",name,...(team?{team_id:team.id}:{})},owner);

test("刷新保留个人库、团队及子页、知识库、笔记、首页筛选和回收站位置",async({page,request})=>{
  const owner=await person(request),team=await api(request,"POST","teams",{name:"刷新团队"},owner),book=await createBook(request,owner,"刷新知识库",team),personal=await createBook(request,owner,"个人刷新库"),note=await api(request,"POST","documents",{space_id:book.id,title:"刷新后保持笔记"},owner);
  await login(page,owner);
  await accountMenu(page,"全部知识库");await expect(page).toHaveURL(/page=personal/);await page.reload();await expect(page.locator(".academic-page-header h1")).toHaveText("导航用户的知识库");
  await accountMenu(page,"团队管理");await expect(page).toHaveURL(/page=teams/);await page.reload();await expect(page.locator(".team-directory")).toContainText(team.name);
  await switchWorkspace(page,team.name);await page.getByRole("link",{name:"团队主页",exact:true}).click();
  for(const [key,label] of [["members","成员"],["settings","设置"],["libraries","知识库"]]){
    await page.locator(".team-hub > .management-tabs").getByRole("button",{name:label,exact:true}).click();await expect(page).toHaveURL(new RegExp("view="+key));await page.reload();await expect(page.locator(".team-hub > .management-tabs button.active")).toHaveText(label);
  }
  await page.locator(".library-open").filter({has:page.locator("h2",{hasText:book.name})}).click();await expect(page).toHaveURL(new RegExp("space="+book.id));await page.reload();await expect(page.locator(".academic-page-header h1")).toHaveText(book.name);
  await page.locator(".note-open").filter({hasText:note.title}).click();await expect(page).toHaveURL(new RegExp("doc="+note.id));await page.reload();await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(note.title);await expect(page.getByRole("complementary",{name:"同库笔记",exact:true})).toContainText(note.title);
  await page.getByRole("button",{name:"返回知识库",exact:true}).click();await page.getByRole("button",{name:"归档",exact:true}).click();await expect(page).toHaveURL(/archived=1/);await page.reload();await expect(page.getByRole("button",{name:"返回笔记",exact:true})).toBeVisible();
  await page.goto("/?space="+personal.id);await expect(page.locator(".academic-page-header h1")).toHaveText(personal.name);
  await page.getByRole("navigation",{name:"主导航",exact:true}).getByRole("link",{name:"首页",exact:true}).click();
  for(const tab of ["mine","team"]){await page.goto(`/?scope=${team.id}&tab=${tab}&q=刷新`);await expect(page.locator(".academic-list-controls > .home-tabs button.active")).toHaveText("团队首页");await expect(page).toHaveURL(new RegExp(`scope=${team.id}&q=`));expect(new URL(page.url()).searchParams.has("tab")).toBe(false);await expect(page.locator(".note-table-row")).toContainText([note.title]);await page.reload();await expect(page.locator(".academic-list-controls > .home-tabs button.active")).toHaveText("团队首页");}
  await switchWorkspace(page,"个人");
  await page.locator(".academic-list-controls > .home-tabs").getByRole("button",{name:"我的分享",exact:true}).click();await expect(page).toHaveURL(/tab=outgoing/);await page.reload();await expect(page.getByRole("region",{name:"我的分享",exact:true})).toBeVisible();
  await page.getByRole("navigation",{name:"分享内容",exact:true}).getByRole("button",{name:"知识库",exact:true}).click();await page.getByLabel("分享状态",{exact:true}).selectOption("all");await expect(page).toHaveURL(/sharing=libraries&status=all/);await page.reload();await expect(page.getByRole("navigation",{name:"分享内容",exact:true}).locator("button.active")).toHaveText("知识库");await expect(page.getByLabel("分享状态",{exact:true})).toHaveValue("all");
  await page.getByRole("navigation",{name:"辅助导航",exact:true}).getByRole("link",{name:/回收站/}).click();await page.getByRole("tab",{name:/^知识库/}).click();await expect(page).toHaveURL(/type=spaces/);await page.reload();await expect(page.getByRole("tab",{name:/^知识库/})).toHaveAttribute("aria-selected","true");
  const geometry=await page.evaluate(()=>{const content=document.querySelector(".academic-sidebar-content")!,bottom=document.querySelector(".sidebar-bottom-row")!,account=document.querySelector<HTMLElement>(".workspace-account-tools")!,main=document.querySelector(".academic-main")!,banner=document.querySelector<HTMLElement>('.workspace-top-banner')!,box=banner.getBoundingClientRect(),style=getComputedStyle(banner),accountBox=account.getBoundingClientRect();return {after:!!(content.compareDocumentPosition(bottom)&Node.DOCUMENT_POSITION_FOLLOWING),mainTop:main.getBoundingClientRect().top,position:getComputedStyle(account).position,bannerBottom:box.bottom,bannerCenter:(box.y+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop)+box.bottom-parseFloat(style.borderBottomWidth)-parseFloat(style.paddingBottom))/2,accountCenter:accountBox.y+accountBox.height/2};});expect(geometry.after).toBe(true);expect(geometry.mainTop).toBe(geometry.bannerBottom);expect(geometry.position).toBe('static');expect(Math.abs(geometry.accountCenter-geometry.bannerCenter)).toBeLessThanOrEqual(1);
});

test("每库最近笔记最多三篇，固定图标具有方向和填充差异",async({page,request})=>{
  const owner=await person(request),book=await createBook(request,owner,"固定方向检查");
  for(let i=0;i<7;i++)await api(request,"POST","documents",{space_id:book.id,title:"最近笔记 "+i},owner);
  const archived=await api(request,"POST","documents",{space_id:book.id,title:"不显示的归档"},owner);await api(request,"PATCH",`documents/${archived.id}`,{archived:true},owner);
  const expected=(await api(request,"GET","documents",undefined,owner)).slice(0,3);
  await login(page,owner);const recent=page.getByRole("region",{name:book.name+"的最近笔记",exact:true});await expect(recent.locator(".sidebar-library-note")).toHaveText(expected.map((item:any)=>item.title));await expect(recent).not.toContainText(archived.title);
  const pin=page.locator(`[data-knowledge-library="${book.id}"] .sidebar-pin`);
  await expect(pin).toHaveAttribute("aria-pressed","false");await expect(pin.locator("svg")).toHaveCSS("transform","matrix(1, 0, 0, 1, 0, 0)");await expect(pin.locator("svg")).toHaveCSS("fill","none");
  await pin.click();await expect(pin).toHaveAttribute("aria-pressed","true");await expect(pin.locator("svg")).toHaveCSS("transform",/0\.707/);await expect(pin.locator("svg")).not.toHaveCSS("fill","none");
  await page.reload();await expect(pin).toHaveAttribute("aria-pressed","true");await recent.locator(".sidebar-library-note").first().click();await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(expected[0].title);
  await sideHome(page);await expect(page.locator(".academic-page-header h1")).toHaveText("首页");await expect(page.locator(".academic-list-controls > .home-tabs button.active")).toHaveText("最近");await expect(page.locator(".note-table-row")).toHaveCount(7);
});

test("我的分享只列本人分享，撤销本人外链保留他人外链；明暗主题一致",async({page,request})=>{
  const owner=await person(request),peer=await person(request,"分享同事"),team=await api(request,"POST","teams",{name:"分享团队"},owner),book=await createBook(request,owner,"团队资料",team),invite=await api(request,"POST",`teams/${team.id}/invites`,{},owner);
  await api(request,"POST",`team-invitations/${new URL(invite.path,"http://test").searchParams.get("invite")}/accept`,{},peer);
  await api(request,"PATCH",`teams/${team.id}`,{allow_external_sharing:true},owner);
  const note=await api(request,"POST","documents",{space_id:book.id,title:"本人分享记录"},peer),own=await api(request,"POST",`documents/${note.id}/sharing/links`,{days:null},owner),other=await api(request,"POST",`documents/${note.id}/sharing/links`,{days:7},peer);
  const outsider=await createBook(request,peer,"陌生的个人库"),privateNote=await api(request,"POST","documents",{space_id:outsider.id,title:"不应出现在我的分享"},peer);await api(request,"POST",`documents/${privateNote.id}/sharing/links`,{days:null},peer);
  const list=await api(request,"GET","me/shares?status=all",undefined,owner);expect(list.items.map((item:any)=>item.id)).toEqual([note.id]);expect(list.items[0].links).toHaveLength(1);expect(JSON.stringify(list)).not.toContain("token_hash");
  await api(request,"DELETE",`me/shares/${note.id}/links`,undefined,await person(request),403);
  await login(page,owner);await switchWorkspace(page,team.name);await page.locator(".academic-list-controls > .home-tabs").getByRole("button",{name:"我的分享",exact:true}).click();const row=page.locator(`[data-share-note="${note.id}"]`);await expect(row).toContainText("包含永久外链");
  for(const theme of ["dark","light"] as const){await chooseTheme(page,theme);await expect(row.locator(".share-note-open strong")).toHaveCSS("color",theme==="dark"?"rgb(229, 233, 240)":/rgb\(/);await expect(row).not.toHaveCSS("background-color","rgb(255, 255, 255)");}
  await row.getByRole("button",{name:"撤销外链",exact:true}).click();await page.getByRole("dialog",{name:"撤销外链",exact:true}).getByRole("button",{name:"确认撤销",exact:true}).click();await expect(page.locator(".share-notice[role=status]")).toContainText("已撤销 1 条外链");
  const ownToken=own.path.split("/").pop(),otherToken=other.path.split("/").pop();expect((await request.get("/api/public/notes/"+ownToken)).status()).toBe(404);expect((await request.get("/api/public/notes/"+otherToken)).status()).toBe(200);
  await page.getByLabel("分享状态",{exact:true}).selectOption("all");await expect(row).toContainText("已失效／已撤销");await page.screenshot({path:"artifacts/web/my-shares-light.png"});
});

async function sideHome(page:Page){await page.getByRole("navigation",{name:"主导航",exact:true}).getByRole("link",{name:"首页",exact:true}).click();}

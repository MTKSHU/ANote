import {test,expect,type APIRequestContext,type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin,login,accountMenu,switchWorkspace,openWorkspaceSwitcher,chooseTheme} from "./helpers";

async function fixture(request:APIRequestContext,email=false){
  const root=await admin(request),username="compact-"+randomUUID().slice(0,8),password="Compact-account-password-123!",name="头像菜单研究用户";
  await api(request,"POST","users",{username,password,name},root);
  const owner={...await api(request,"POST","auth/login",{username,password}),username,password};
  const address=username+"@example.test";
  if(email)await api(request,"PATCH","team/members/"+owner.user.id,{email:address,email_verified:true},root);
  const personal=await api(request,"POST","spaces",{kind:"personal",name:"紧凑个人资料"},owner);
  const first=await api(request,"POST","teams",{name:"视觉研究团队"},owner);
  const long=await api(request,"POST","teams",{name:"这是一支名称很长的跨学科研究团队，用于验证右上角切换不会挤压页面"},owner);
  const book=await api(request,"POST","spaces",{kind:"team",team_id:first.id,name:"视觉研究资料"},owner);
  await api(request,"POST","documents",{space_id:book.id,title:"视觉研究内容"},owner);
  const longBook=await api(request,"POST","spaces",{kind:"team",team_id:long.id,name:"长团队研究资料"},owner);
  const longNote=await api(request,"POST","documents",{space_id:longBook.id,title:"长团队名下的页头验证笔记"},owner);
  const note=await api(request,"POST","documents",{space_id:personal.id,title:"紧凑页头中的笔记"},owner);
  return {owner,name,address,personal,first,long,book,note,longNote};
}
const tools=(page:Page)=>page.getByRole("group",{name:"用户与消息",exact:true});
const avatar=(page:Page)=>tools(page).getByRole("button",{name:"用户菜单",exact:true});
async function readyDocument(page:Page,title:string,scopeLabel:string){
  await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(title);
  await expect(page.getByTestId("editor")).toBeVisible();
  const choices=await openWorkspaceSwitcher(page);
  await expect(choices.getByRole("menuitemradio")).toHaveCount(3);
  await expect(choices.getByRole("menuitemradio",{name:scopeLabel,exact:true})).toHaveAttribute("aria-checked","true");
  await page.keyboard.press("Escape");await page.keyboard.press("Escape");
  const list=page.getByRole("complementary",{name:"同库笔记",exact:true});
  const mobileList=page.getByRole("button",{name:"显示笔记列表",exact:true});
  if(await mobileList.count()){
    const drawer=page.getByRole("dialog",{name:"同库笔记",exact:true});
    await expect(drawer).toBeHidden();await mobileList.click();await expect(drawer).toBeVisible();await expect(list).toBeVisible();
    await drawer.getByRole("button",{name:"关闭笔记列表",exact:true}).click();await expect(drawer).toBeHidden();return;
  }
  await expect(list).toBeVisible();await expect(list.getByRole("button",{name:"隐藏笔记列表",exact:true})).toHaveAttribute("aria-expanded","true");
}

test("头像菜单按指定顺序显示操作，工作空间二级菜单切换个人与全部团队且支持键盘",async({page,request})=>{
  const f=await fixture(request,true),additional=[];
  for(let index=0;index<9;index++)additional.push(await api(request,"POST","teams",{name:`完整团队列表 ${index+1}`},f.owner));
  await login(page,f.owner);
  await expect(tools(page)).toHaveCount(1);await expect(avatar(page)).toHaveText("头");
  await expect(tools(page).getByRole("button",{name:/^切换空间：/})).toHaveCount(0);
  await expect(page.locator(".workspace-scope-menu")).toHaveCount(0);
  await expect(page.locator(".workspace-account-menu > summary")).not.toContainText(f.name);
  await page.screenshot({path:"artifacts/web/compact-account-home.png"});
  await avatar(page).focus();await page.keyboard.press("ArrowDown");
  const userMenu=page.getByRole("menu",{name:"用户菜单",exact:true});
  await expect(userMenu).toBeVisible();await expect(userMenu.locator(".workspace-account-identity strong")).toHaveText(f.name);await expect(userMenu.locator(".workspace-account-identity small")).toHaveText(f.address);
  await page.screenshot({path:"artifacts/web/compact-account-avatar-menu.png"});
  for(const name of ["好友管理","团队管理","检查更新","设置","退出登录"])await expect(userMenu.getByRole("menuitem",{name,exact:true})).toBeVisible();
  await expect(userMenu.getByRole("menuitem")).toHaveText(["工作空间切换","好友管理","团队管理","检查更新","设置","退出登录"]);
  await expect(userMenu.getByRole("group",{name:"外观",exact:true})).toHaveCount(0);
  await expect(userMenu.getByRole("menuitemradio",{name:f.first.name,exact:true})).toHaveCount(0);
  const parent=userMenu.getByRole("menuitem",{name:"工作空间切换",exact:true});
  await expect(parent).toBeFocused();await expect(parent).toHaveAttribute("aria-haspopup","menu");
  await page.keyboard.press("ArrowRight");
  const spaces=page.getByRole("menu",{name:"工作空间切换",exact:true});
  await expect(userMenu).toBeVisible();await expect(spaces).toBeVisible();
  await expect(spaces.getByRole("menuitemradio")).toHaveCount(3+additional.length);
  for(const name of ["个人",f.first.name,f.long.name,...additional.map(team=>team.name)])await expect(spaces.getByRole("menuitemradio",{name,exact:true})).toBeAttached();
  await expect(spaces.getByRole("menuitemradio",{name:"本地模式",exact:true})).toHaveCount(0);
  await expect(spaces.getByRole("menuitemradio",{name:"个人",exact:true})).toBeFocused();
  await page.keyboard.press("End");await expect(spaces.getByRole("menuitemradio").last()).toBeFocused();await expect(spaces.getByRole("menuitemradio").last()).toBeInViewport();
  await page.keyboard.press("Home");await expect(spaces.getByRole("menuitemradio",{name:"个人",exact:true})).toBeFocused();
  await page.keyboard.press("ArrowLeft");await expect(spaces).toBeHidden();await expect(parent).toBeFocused();
  await page.keyboard.press("Enter");await expect(spaces).toBeVisible();
  await page.keyboard.press("Escape");await expect(spaces).toBeHidden();await expect(userMenu).toBeVisible();await expect(parent).toBeFocused();
  await page.keyboard.press("Escape");await expect(userMenu).toBeHidden();await expect(avatar(page)).toBeFocused();
  await openWorkspaceSwitcher(page);
  await page.screenshot({path:"artifacts/web/compact-account-scope-menu.png"});
  await expect(spaces.getByRole("menuitem",{name:"设置",exact:true})).toHaveCount(0);
  await spaces.getByRole("menuitemradio",{name:f.first.name,exact:true}).click();
  await expect(page.locator(".academic-page-header h1")).toHaveText(f.first.name);await expect(userMenu).toBeHidden();
  await expect(page.locator(`[data-knowledge-library="${f.book.id}"]`)).toBeVisible();
  await switchWorkspace(page,f.long.name);await expect(page.locator(".academic-page-header h1")).toHaveText(f.long.name);await page.reload();await expect(page.locator(".academic-page-header h1")).toHaveText(f.long.name);
  await switchWorkspace(page,"个人");await expect(page.locator(".academic-page-header h1")).toHaveText("首页");
  await chooseTheme(page,"dark");await chooseTheme(page,"light");
  const currentURL=page.url(),checked=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/version");
  await avatar(page).click();await userMenu.getByRole("menuitem",{name:"检查更新",exact:true}).click();expect((await checked).status()).toBe(200);
  const notice=page.getByRole("status",{name:"平台更新提醒",exact:true});await expect(notice).toContainText("当前已是最新版本");expect(page.url()).toBe(currentURL);await expect(page.getByRole("dialog",{name:"设置",exact:true})).toHaveCount(0);await notice.getByRole("button",{name:"关闭",exact:true}).click();
  await accountMenu(page,"好友");await expect(page.locator(".social-page h1")).toHaveText("好友");await accountMenu(page,"团队管理");await expect(page.locator(".team-directory")).toContainText(f.first.name);
  await avatar(page).click();await page.locator(".team-heading h1").click();await expect(userMenu).toBeHidden();
  await openWorkspaceSwitcher(page);await page.locator(".team-heading h1").click();await expect(userMenu).toBeHidden();await expect(spaces).toBeHidden();
  await page.screenshot({path:"artifacts/web/compact-account-teams.png"});
});

const cornerReference=new Map<string,{tools:{x:number;y:number;width:number;height:number};navigation:{x:number;y:number;width:number;height:number}}>();
async function geometry(page:Page,label:string){
  await expect(tools(page)).toHaveCount(1);
  const result=await page.evaluate(()=>{
    const tools=document.querySelector<HTMLElement>(".workspace-account-tools")!,main=document.querySelector<HTMLElement>(".academic-main")!,header=main.querySelector<HTMLElement>(".academic-page-header,.team-heading,.academic-document-header")!;
    const rect=(element:Element)=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
    const box=rect(tools),toggle=document.querySelector<HTMLElement>('[aria-label="收起侧边栏"],[aria-label="展开侧边栏"]')!,navigation=rect(toggle),brand=document.querySelector<HTMLElement>(".academic-brand,.sidebar-collapsed-home")!,brandBox=rect(brand);
    const actions=[...header.querySelectorAll<HTMLElement>("h1,.document-title-wrap,.academic-page-actions > button,.academic-page-actions > a,.team-header-actions button,.document-actions > button,.document-actions > details"),...main.querySelectorAll<HTMLElement>(".library-note-list > header > button")].filter(node=>node.getClientRects().length).map(rect);
    const overlap=(a:typeof box,b:typeof box)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>.5;
    const controls=[tools.querySelector<HTMLElement>(".sidebar-notifications")!,tools.querySelector<HTMLElement>(".workspace-avatar-trigger")!,toggle,brand];
    const blocked=controls.filter(node=>{const b=node.getBoundingClientRect();return !node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}).map(node=>node.getAttribute("aria-label")||node.className);
    const banner=document.querySelector<HTMLElement>('.workspace-top-banner')!,bannerBox=rect(banner),bannerStyle=getComputedStyle(banner),bannerCenter=(bannerBox.y+parseFloat(bannerStyle.borderTopWidth)+parseFloat(bannerStyle.paddingTop)+bannerBox.bottom-parseFloat(bannerStyle.borderBottomWidth)-parseFloat(bannerStyle.paddingBottom))/2;
    return {mobile:!!document.querySelector('.academic-workspace.workspace-mobile'),banner:bannerBox,bannerCenter,mainTop:rect(main).y,mainOverflow:main.scrollWidth-main.clientWidth,tools:box,navigation,brand:brandBox,header:rect(header),viewport:innerWidth,overlaps:actions.filter(action=>overlap(action,box)||overlap(action,navigation)||overlap(action,brandBox)),blocked,document:header.classList.contains("academic-document-header"),titleWidth:header.querySelector(".document-title-wrap")?.getBoundingClientRect().width};
  });
  expect(result.banner.height,label).toBe(result.mobile?60:56);expect(result.mainTop,label).toBe(result.banner.bottom);expect(result.tools.width,label).toBeLessThanOrEqual(110);expect(result.tools.height,label).toBeLessThanOrEqual(result.mobile?44:40);expect(result.tools.right,label).toBeLessThanOrEqual(result.viewport+1);expect(result.tools.x,label).toBeGreaterThanOrEqual(0);expect(Math.abs(result.tools.y+result.tools.height/2-result.bannerCenter),label).toBeLessThanOrEqual(1);expect(Math.abs(result.navigation.y+result.navigation.height/2-result.bannerCenter),label).toBeLessThanOrEqual(1);expect(result.navigation.x,label).toBe(result.mobile?8:16);expect(result.mainOverflow,label).toBeLessThanOrEqual(1);expect(result.overlaps,label).toEqual([]);expect(result.blocked,label).toEqual([]);
  const key=label.split("/").slice(0,2).join("/"),reference=cornerReference.get(key);
  if(reference){for(const corner of ["tools","navigation"] as const)for(const coordinate of ["x","y","width","height"] as const)expect(Math.abs(result[corner][coordinate]-reference[corner][coordinate]),`${label} ${corner}.${coordinate}`).toBeLessThanOrEqual(1);}
  else cornerReference.set(key,{tools:result.tools,navigation:result.navigation});
  await test.info().attach("fixed-corner-geometry",{body:JSON.stringify({label,...result}),contentType:"application/json"});
  if(result.document&&result.viewport>=1000){expect(result.header.y,label).toBe(result.banner.bottom);expect(result.header.height,label).toBeLessThanOrEqual(69);expect(result.titleWidth,label).toBeGreaterThanOrEqual(60);}
}

test("浏览、团队、消息与笔记的左右角落固定坐标，折叠和窄屏不覆盖页面内容或操作",async({page,request})=>{
  test.setTimeout(180_000);
  cornerReference.clear();
  const f=await fixture(request);await login(page,f.owner);
  await avatar(page).click();await expect(page.locator(".workspace-account-identity small")).toHaveCount(0);await page.keyboard.press("Escape");
  const pages=[{path:"/?page=home&scope=personal",heading:"首页"},{path:"/?page=personal&scope=personal",heading:f.name+"的知识库"},{path:"/?space="+f.personal.id+"&scope=personal",heading:f.personal.name},{path:"/?page=teams&scope=personal",heading:"我的团队"},{path:"/?team="+f.first.id+"&scope="+f.first.id,heading:f.first.name},{path:"/?page=notifications&scope=personal",heading:"消息通知"},{path:"/?page=friends&scope=personal",heading:"好友"},{path:"/?page=wishes&scope=personal",heading:"许愿池"},{path:"/?page=trash&scope=personal",heading:"回收站"},{path:"/?doc="+f.note.id+"&scope=personal",title:f.note.title},{path:"/?doc="+f.longNote.id+"&scope="+f.long.id,title:f.longNote.title}];
  for(const width of [1580,1180,1000]){
    await page.setViewportSize({width,height:1000});
    for(const collapsed of [false,true]){
      await page.goto("/?page=home&scope=personal");await expect(page.locator(".academic-page-header h1")).toHaveText("首页");
      const toggle=page.getByRole("button",{name:collapsed?"收起侧边栏":"展开侧边栏",exact:true});if(await toggle.count())await toggle.click();
      for(const route of pages){
        await page.goto(route.path);if(route.heading)await expect(page.locator(".academic-page-header h1,.team-heading h1")).toHaveText(route.heading);else await readyDocument(page,route.title!,route.title===f.longNote.title?f.long.name:"个人");
        await geometry(page,`${width}/${collapsed}/${route.path}`);
        if(width===1000&&!collapsed&&route.path.startsWith("/?doc="))await page.screenshot({path:"artifacts/web/compact-account-note-1000-expanded.png"});
        if(width===1180&&!collapsed&&route.path.includes("doc="+f.longNote.id))await page.screenshot({path:"artifacts/web/compact-account-note-long-team-1180.png"});
        if(route.path.startsWith("/?page=home")){const header=page.locator(".academic-page-header"),h1=(await header.locator("h1").boundingBox())!;expect(h1.y).toBeLessThan(107);expect((await header.boundingBox())!.height).toBeLessThan(55);}
      }
    }
  }
  for(const width of [760,600]){
    await page.setViewportSize({width,height:900});
    for(const collapsed of [false,true]){
    await page.goto("/?page=home&scope=personal");await expect(page.locator(".academic-page-header h1")).toHaveText("首页");
    const toggle=page.getByRole("button",{name:collapsed?"收起侧边栏":"展开侧边栏",exact:true});if(await toggle.count())await toggle.click();
    for(const path of ["/?page=home&scope=personal","/?doc="+f.note.id+"&scope=personal","/?doc="+f.longNote.id+"&scope="+f.long.id,"/?team="+f.long.id+"&scope="+f.long.id]){
      await page.goto(path);if(path.startsWith("/?doc=")){const long=path.includes("doc="+f.longNote.id);await readyDocument(page,long?f.longNote.title:f.note.title,long?f.long.name:"个人");}await geometry(page,`${width}/${collapsed}/${path}`);
      for(const nested of [false,true]){
        if(nested)await openWorkspaceSwitcher(page);else await avatar(page).click();
        const menu=page.getByRole("menu",{name:nested?"工作空间切换":"用户菜单",exact:true}),box=(await menu.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);await page.keyboard.press("Escape");await expect(menu).toBeHidden();if(nested)await page.keyboard.press("Escape");
      }
      if(width===600&&collapsed&&path.includes("doc="+f.longNote.id))await page.screenshot({path:"artifacts/web/svg-submenu-note-fixed-corners-600.png"});
    }
    }
  }
  await page.setViewportSize({width:1580,height:1000});await page.goto("/?doc="+f.note.id);await readyDocument(page,f.note.title,"个人");
  await page.emulateMedia({media:"print"});await expect(tools(page)).toBeHidden();await page.emulateMedia({media:"screen"});
  await page.screenshot({path:"artifacts/web/compact-account-note-collapsed.png"});
});

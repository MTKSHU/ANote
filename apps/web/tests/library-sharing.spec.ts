import {test,expect,type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import pg from "pg";
import * as Y from "yjs";
import {HocuspocusProvider} from "@hocuspocus/provider";
import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {admin,api,login,chooseTheme} from "./helpers";
async function person(request:APIRequestContext,name="知识库作者") {
  const root=await admin(request),username="libshare-"+randomUUID().slice(0,8),password="Library-sharing-fixture-123!";
  await api(request,"POST","users",{username,password,name},root);
  return {...await api(request,"POST","auth/login",{username,password}),username,password};
}
const tokenOf=(link:any)=>link.path.split("/").pop();

test("邮箱分享要求验证身份，只读协作连接不能写入且撤销后断开",async({request,page})=>{
  expect(process.env.BASE_URL).toBe("http://anote.internal:3000");expect((await request.get("/api/platform/public").then(r=>r.json())).public_origin).toBe("http://anote.internal:3000");
  const owner=await person(request),reader=await person(request,"邮箱读者"),book=await api(request,"POST","spaces",{kind:"personal",name:"邮箱与协作权限"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"只读协作正文"},owner),email=randomUUID()+"@example.test";
  const sql=new pg.Pool({host:"db",user:"anote",database:"anote",password:process.env.DB_PASSWORD});
  try{await sql.query("INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'viewer')",[book.id,reader.user.id]);await api(request,"GET",`documents/${note.id}`,undefined,reader,403);await sql.query("UPDATE users SET email=$2,email_verified=false WHERE id=$1",[reader.user.id,email]);await api(request,"POST",`spaces/${book.id}/sharing/members`,{identity:email},owner,404);await sql.query("UPDATE users SET email_verified=true WHERE id=$1",[reader.user.id]);}finally{await sql.end();}
  await api(request,"POST",`spaces/${book.id}/sharing/members`,{identity:email},owner);
  const document=new Y.Doc();let synced=false,disconnected=0;
  const provider=new HocuspocusProvider({url:process.env.BASE_URL!.replace(/^http/,"ws")+"/collab",name:note.id,document,token:JSON.stringify({schema:EDITOR_SCHEMA_VERSION,token:reader.token}),onSynced:()=>{synced=true;},onDisconnect:()=>{disconnected++;}});
  try{await expect.poll(()=>synced).toBe(true);const before=await api(request,"GET",`documents/${note.id}`,undefined,owner);(document.getXmlFragment("default").get(0) as Y.XmlElement).insert(0,[new Y.XmlText("越权输入")]);await page.waitForTimeout(1800);expect((await api(request,"GET",`documents/${note.id}`,undefined,owner)).hash).toBe(before.hash);await api(request,"DELETE",`spaces/${book.id}/sharing/members/${reader.user.id}`,undefined,owner);await expect.poll(()=>disconnected).toBeGreaterThan(0);await api(request,"GET",`documents/${note.id}`,undefined,reader,403);}finally{provider.destroy();document.destroy();}
});

test("整库指定成员只读，精确账号匹配且不枚举用户；撤销后旧笔记和新增笔记均失去访问",async({request})=>{
  const owner=await person(request),reader=await person(request,"指定读者"),stranger=await person(request,"陌生账号"),root=await admin(request),book=await api(request,"POST","spaces",{kind:"personal",name:"指定只读整库"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"原有私人笔记"},owner);
  await api(request,"POST",`spaces/${book.id}/sharing/members`,{identity:"libshare-"},owner,404);
  const grant=await api(request,"POST",`spaces/${book.id}/sharing/members`,{identity:reader.username,role:"admin"},owner);expect(grant.members.map((m:any)=>m.id)).toEqual([reader.user.id]);expect(JSON.stringify(grant)).not.toContain(stranger.username);expect(JSON.stringify(grant)).not.toContain("token_hash");
  const libraries=await api(request,"GET","spaces",undefined,reader);expect(libraries.find((b:any)=>b.id===book.id).role).toBe("viewer");expect((await api(request,"GET",`documents/${note.id}`,undefined,reader)).role).toBe("viewer");
  const fresh=await api(request,"POST","documents",{space_id:book.id,title:"分享后新增"},owner);expect((await api(request,"GET",`documents/${fresh.id}`,undefined,reader)).role).toBe("viewer");
  await api(request,"POST","documents",{space_id:book.id,title:"不得写入"},reader,403);await api(request,"PATCH",`documents/${note.id}`,{title:"不得篡改"},reader,403);await api(request,"DELETE",`documents/${note.id}`,undefined,reader,403);await api(request,"DELETE",`spaces/${book.id}`,undefined,reader,403);
  await api(request,"GET",`spaces/${book.id}/sharing`,undefined,reader,403);await api(request,"POST",`spaces/${book.id}/sharing/links`,{days:null},reader,403);await api(request,"GET",`spaces/${book.id}/sharing`,undefined,root,403);await api(request,"GET",`documents/${note.id}`,undefined,stranger,403);
  const sharing=await api(request,"GET",`documents/${note.id}/sharing`,undefined,owner);expect(sharing.library_shared).toBe(true);
  await api(request,"DELETE",`spaces/${book.id}/sharing/members/${reader.user.id}`,undefined,owner);await api(request,"GET",`documents/${note.id}`,undefined,reader,403);await api(request,"GET",`documents/${fresh.id}`,undefined,reader,403);expect((await api(request,"GET","spaces",undefined,reader)).some((b:any)=>b.id===book.id)).toBe(false);
});

test("整库外链支持永久、限时、范围隔离、归档过滤及移动；删除恢复不重新启用旧链接",async({request})=>{
  const owner=await person(request),reader=await person(request,"整库读者"),book=await api(request,"POST","spaces",{kind:"personal",name:"互联网整库"},owner),other=await api(request,"POST","spaces",{kind:"personal",name:"另一私人库"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"对外笔记"},owner),hidden=await api(request,"POST","documents",{space_id:book.id,title:"归档不公开"},owner),outside=await api(request,"POST","documents",{space_id:other.id,title:"不能跨库读取"},owner);
  await api(request,"PATCH",`documents/${hidden.id}`,{archived:true},owner);
  await api(request,"POST",`spaces/${book.id}/sharing/members`,{identity:reader.username},owner);
  const permanent=await api(request,"POST",`spaces/${book.id}/sharing/links`,{days:null},owner),timed=await api(request,"POST",`spaces/${book.id}/sharing/links`,{days:7},owner);expect(permanent.expires_at).toBeNull();expect(Date.parse(timed.expires_at)).toBeGreaterThan(Date.now()+6*86400000);
  await api(request,"POST",`spaces/${book.id}/sharing/links`,{days:0},owner,400);
  const base="/api/public/libraries/"+tokenOf(permanent),listing=await request.get(base).then(r=>r.json());expect(listing.notes.map((n:any)=>n.id)).toEqual([note.id]);expect(listing).not.toHaveProperty("snapshot");
  expect((await request.get(base+"/notes/"+outside.id)).status()).toBe(404);expect((await request.get(base+"/notes/"+hidden.id)).status()).toBe(404);expect((await request.get(base+"/notes/"+note.id)).status()).toBe(200);
  const added=await api(request,"POST","documents",{space_id:book.id,title:"新增也对外可见"},owner);expect((await request.get(base).then(r=>r.json())).notes.map((n:any)=>n.id)).toContain(added.id);
  const move=await api(request,"POST",`documents/${note.id}/move-preview`,{library_id:other.id},owner);await api(request,"POST",`documents/${note.id}/move`,move,owner);expect((await request.get(base+"/notes/"+note.id)).status()).toBe(404);await api(request,"GET",`documents/${note.id}`,undefined,reader,403);
  await api(request,"DELETE",`spaces/${book.id}`,undefined,owner);expect((await request.get(base)).status()).toBe(404);await api(request,"POST",`spaces/${book.id}/restore-deleted`,{},owner);expect((await request.get(base)).status()).toBe(404);
  const team=await api(request,"POST","teams",{name:"团队不使用个人分享"},owner),teamBook=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"团队库"},owner);await api(request,"POST",`spaces/${teamBook.id}/sharing/links`,{days:7},owner,403);
});

test("整库链接过期和永久清理均有效，我的分享按状态筛选且不泄露其他人的记录",async({request})=>{
  expect(process.env.BASE_URL).toBe("http://anote.internal:3000");expect((await request.get("/api/platform/public").then(r=>r.json())).public_origin).toBe("http://anote.internal:3000");
  const owner=await person(request),peer=await person(request,"别人的分享"),book=await api(request,"POST","spaces",{kind:"personal",name:"过期分享检查"},owner),link=await api(request,"POST",`spaces/${book.id}/sharing/links`,{days:1},owner);
  const sql=new pg.Pool({host:"db",user:"anote",database:"anote",password:process.env.DB_PASSWORD});
  try{await sql.query("UPDATE library_share_links SET expires_at=now()-interval '1 hour' WHERE id=$1 AND created_by=$2",[link.id,owner.user.id]);}finally{await sql.end();}
  expect((await request.get("/api/public/libraries/"+tokenOf(link))).status()).toBe(404);expect((await api(request,"GET","me/library-shares?status=active",undefined,owner)).items).toHaveLength(0);expect((await api(request,"GET","me/library-shares?status=inactive",undefined,owner)).items.map((b:any)=>b.id)).toEqual([book.id]);expect((await api(request,"GET","me/library-shares?status=all",undefined,peer)).items).toHaveLength(0);
  await api(request,"DELETE",`me/library-shares/${book.id}/links`,undefined,peer,403);await api(request,"DELETE",`me/library-shares/${book.id}/links`,undefined,owner);
  await api(request,"DELETE",`spaces/${book.id}`,undefined,owner);const trash=(await api(request,"GET","trash/spaces",undefined,owner)).find((b:any)=>b.id===book.id);await api(request,"DELETE",`trash/spaces/${book.id}`,{deletion_token:trash.trash_batch},owner);expect((await api(request,"GET","me/library-shares?status=all",undefined,owner)).items).toHaveLength(0);
});

test("个人知识库分享界面、共享知识库入口、公开阅读与图片、我的分享撤销支持明暗主题",async({page,browser,request})=>{
  const owner=await person(request),reader=await person(request,"网页读者"),book=await api(request,"POST","spaces",{kind:"personal",name:"网页共享整库"},owner),folder=await api(request,"POST",`spaces/${book.id}/folders`,{name:"公开目录"},owner),note=await api(request,"POST","documents",{space_id:book.id,folder_id:folder.id,title:"公开图文笔记"},owner);
  await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toBeVisible();await page.getByLabel("上传附件文件",{exact:true}).setInputFiles("artifacts/server/fixtures/sample.png");await expect(page.locator(".media-resource img")).toHaveJSProperty("naturalWidth",64);
  await page.getByRole("button",{name:"返回知识库",exact:true}).click();await page.getByRole("button",{name:"分享知识库",exact:true}).click();const dialog=page.getByRole("dialog",{name:"分享知识库",exact:true});await expect(dialog).toContainText("现有及后续新增");await dialog.getByLabel("完整用户名或已验证邮箱",{exact:true}).fill(reader.username);await dialog.getByRole("button",{name:"添加只读成员",exact:true}).click();await expect(dialog).toContainText("网页读者");await expect(dialog.getByRole("status")).toHaveText("已添加只读成员");
  await dialog.getByRole("navigation",{name:"知识库分享方式",exact:true}).getByRole("button",{name:"互联网",exact:true}).click();await dialog.getByLabel("知识库外链有效期",{exact:true}).selectOption("permanent");await dialog.getByRole("button",{name:"生成整库外链",exact:true}).click();const external=await dialog.getByLabel("知识库外部链接",{exact:true}).inputValue();
  for(const theme of ["dark","light"] as const){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await expect(dialog).toBeVisible();await page.screenshot({path:`artifacts/web/library-sharing-${theme}.png`});}
  await dialog.getByRole("button",{name:"关闭",exact:true}).click();
  const visitor=await browser.newContext(),publicPage=await visitor.newPage();
  try{await publicPage.goto(external);await expect(publicPage.getByRole("complementary",{name:"共享知识库笔记",exact:true})).toContainText(folder.name);await expect(publicPage.getByRole("heading",{name:note.title,exact:true})).toBeVisible();await expect(publicPage.locator(".media-resource img")).toHaveJSProperty("naturalWidth",64);await expect(publicPage.getByTestId("editor")).toHaveAttribute("contenteditable","false");
    await publicPage.getByRole("complementary",{name:"共享知识库笔记",exact:true}).getByRole("button",{name:note.title,exact:true}).click();await publicPage.reload();await expect(publicPage.getByRole("heading",{name:note.title,exact:true})).toBeVisible();
    const otherPage=await browser.newPage();try{await login(otherPage,reader);await otherPage.locator(".academic-list-controls > .home-tabs").getByRole("button",{name:"分享给我",exact:true}).click();await expect(otherPage.getByRole("region",{name:"分享给我的知识库",exact:true})).toContainText(book.name);await otherPage.getByRole("region",{name:"分享给我的知识库",exact:true}).getByRole("button",{name:new RegExp(book.name)}).click();await expect(otherPage.getByRole("button",{name:"新建笔记",exact:true})).toBeDisabled();await expect(otherPage.getByRole("button",{name:"分享知识库",exact:true})).toHaveCount(0);}finally{await otherPage.close();}
    await page.getByRole("navigation",{name:"主导航",exact:true}).getByRole("link",{name:"首页",exact:true}).click();await page.locator(".academic-list-controls > .home-tabs").getByRole("button",{name:"我的分享",exact:true}).click();const mine=page.getByRole("region",{name:"我的分享",exact:true});await mine.getByRole("navigation",{name:"分享内容",exact:true}).getByRole("button",{name:"知识库",exact:true}).click();const row=mine.locator(`[data-share-note="${book.id}"]`);await expect(row).toContainText("1 位指定成员");await row.getByRole("button",{name:"撤销外链",exact:true}).click();await page.getByRole("dialog",{name:"撤销外链",exact:true}).getByRole("button",{name:"确认撤销",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"已撤销 1 条外链"})).toBeVisible();await expect(publicPage.getByRole("status")).toHaveText("知识库分享已失效");
    expect((await api(request,"GET",`documents/${note.id}`,undefined,reader)).role).toBe("viewer");
  }finally{await visitor.close();}
});

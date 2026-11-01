import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {api,admin,login,chooseTheme} from "./helpers";
async function fixture(request:any) {
  const root=await admin(request),password="Catalog-test-123!";
  async function person(){const username="catalog-"+randomUUID().slice(0,8);await api(request,"POST","users",{username,password,name:username},root);return {...await api(request,"POST","auth/login",{username,password}),username,password};}
  const owner=await person(),peer=await person(),team=await api(request,"POST","teams",{name:"目录团队"},owner);
  const invite=await api(request,"POST",`teams/${team.id}/invites`,{},owner);
  await api(request,"POST",`team-invitations/${new URL(invite.path,"http://test").searchParams.get("invite")}/accept`,{},peer);
  const book=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"层级资料"},owner);
  const f1=await api(request,"POST",`spaces/${book.id}/folders`,{name:"目录甲"},owner),f2=await api(request,"POST",`spaces/${book.id}/folders`,{name:"目录乙",parent_id:f1.id},owner);
  const a=await api(request,"POST","documents",{space_id:book.id,title:"根笔记甲"},owner),b=await api(request,"POST","documents",{space_id:book.id,title:"目录笔记",folder_id:f2.id},owner),c=await api(request,"POST","documents",{space_id:book.id,title:"根笔记乙"},peer);
  return {root,owner,peer,team,book,f1,f2,a,b,c};
}
test("知识库混合排序持久化，防循环、跨库与越权，私有笔记不泄露",async({request})=>{
  const {owner,peer,book,f1,f2,a,b,c}=await fixture(request);
  const read=(account=owner)=>api(request,"GET",`spaces/${book.id}/catalog`,undefined,account);
  const move=async(kind:string,id:string,parent_id:string|null,before:string|null,account=owner,status?:number)=>api(request,"PATCH",`spaces/${book.id}/catalog`,{revision:(await read(account)).revision,kind,id,parent_id,before},account,status);
  await move("note",a.id,null,"folder:"+f1.id);
  await move("note",b.id,null,"note:"+c.id);
  let value=await read();expect(value.items.filter((e:any)=>!e.parent_id).map((e:any)=>e.key)).toEqual(["note:"+a.id,"folder:"+f1.id,"note:"+b.id,"note:"+c.id]);
  expect((await api(request,"GET",`documents/${b.id}`,undefined,owner)).folder_id).toBe(null);
  await move("folder",f1.id,f2.id,null,owner,400);
  await move("folder",f1.id,null,null,peer,403);
  await move("note",a.id,f1.id,null,peer,403);
  await move("note",c.id,f1.id,null,peer);
  const other=await api(request,"POST","spaces",{name:"别的知识库",kind:"personal"},owner),foreign=await api(request,"POST",`spaces/${other.id}/folders`,{name:"外部目录"},owner);
  await move("note",a.id,foreign.id,null,owner,400);
  value=await read();await api(request,"PATCH",`spaces/${book.id}/catalog`,{revision:"-1",kind:"note",id:a.id,parent_id:null},owner,409);
  const hidden=await api(request,"POST","documents",{space_id:book.id,title:"私密笔记",visibility:"private"},owner);
  expect((await read(peer)).items.some((e:any)=>e.id===hidden.id)).toBe(false);
  expect((await api(request,"GET","spaces",undefined,peer)).find((s:any)=>s.id===book.id)).not.toHaveProperty("catalog_order");
  expect((await api(request,"GET",`teams/${book.team_id}`,undefined,peer)).libraries.find((s:any)=>s.id===book.id)).not.toHaveProperty("catalog_order");
  await api(request,"PATCH",`teams/${book.team_id}`,{pinned_note_ids:[hidden.id,a.id]},owner);
  expect((await api(request,"GET",`teams/${book.team_id}`,undefined,peer)).pinned_note_ids).toEqual([a.id]);
  expect((await api(request,"GET","teams",undefined,peer)).find((t:any)=>t.id===book.team_id).pinned_note_ids).toEqual([a.id]);
  await api(request,"PATCH",`teams/${book.team_id}`,{pinned_note_ids:[foreign.id]},owner,400);
});
test("目录单击折叠全部后代，重载保留；目录与笔记拖拽排序及移动",async({page,request})=>{
  const {owner,book,f1,f2,a,b,c}=await fixture(request);await login(page,owner);await page.goto("/?space="+book.id);
  const root=page.locator(".library-outline"),folder=page.locator(".folder-open").filter({hasText:"目录甲"}),child=page.locator(".folder-open").filter({hasText:"目录乙"});
  await expect(root.locator(".note-open").filter({hasText:b.title})).toBeVisible();
  await folder.click();await expect(folder).toHaveAttribute("aria-expanded","false");await expect(child).toHaveCount(0);await expect(root.locator(".note-open").filter({hasText:b.title})).toHaveCount(0);
  await expect(root.locator(".note-open").filter({hasText:a.title})).toBeVisible();await page.reload();await expect(folder).toHaveAttribute("aria-expanded","false");await folder.click();await expect(child).toBeVisible();
  const first=root.locator(`[data-item-key="note:${a.id}"]`),target=root.locator(`[data-item-key="folder:${f1.id}"]`);
  await first.dragTo(target,{targetPosition:{x:160,y:2}});
  await expect.poll(async()=> (await api(request,"GET",`spaces/${book.id}/catalog`,undefined,owner)).items.filter((e:any)=>!e.parent_id)[0].key).toBe("note:"+a.id);
  await expect(root).toHaveAttribute("aria-busy","false");
  const nested=root.locator(`[data-item-key="folder:${f2.id}"]`);
  await nested.locator(".folder-open").dragTo(root.locator(`[data-item-key="note:${c.id}"]`),{targetPosition:{x:160,y:2}});
  await expect.poll(async()=> (await api(request,"GET",`spaces/${book.id}/folders`,undefined,owner)).find((f:any)=>f.id===f2.id).parent_id).toBe(null);
  await expect(root).toHaveAttribute("aria-busy","false");
  await first.dragTo(target,{targetPosition:{x:160,y:32}});
  await expect.poll(async()=> (await api(request,"GET",`documents/${a.id}`,undefined,owner)).folder_id).toBe(f1.id);
  await folder.click();await expect(root.locator(".note-open").filter({hasText:a.title})).toHaveCount(0);await expect(root.locator(".note-open").filter({hasText:b.title})).toBeVisible();
  await chooseTheme(page,"dark");await page.screenshot({path:"artifacts/web/library-outline-dark.png",fullPage:true});await page.reload();await expect(folder).toHaveAttribute("aria-expanded","false");
});
test("团队首页仅置顶与最近笔记，知识库页复用个人布局并提供编辑、权限和删除",async({page,request})=>{
  const {owner,peer,team,book,a}=await fixture(request);await api(request,"PATCH",`teams/${team.id}`,{pinned_note_ids:[a.id]},owner);
  await login(page,owner);await page.goto("/?team="+team.id);
  await expect(page.locator(".team-pinned")).toContainText(a.title);await expect(page.locator(".team-recent").last()).toContainText(a.title);await expect(page.locator(".team-hub .library-grid")).toHaveCount(0);
  await expect(page.locator(".team-hub .management-tabs button")).toHaveText(["首页","知识库","成员","设置"]);
  await page.getByRole("button",{name:"知识库",exact:true}).click();const card=page.locator(".library-card").filter({hasText:book.name});await expect(card).toBeVisible();await card.getByRole("button",{name:"管理知识库 "+book.name,exact:true}).click();
  let dialog=page.getByRole("dialog",{name:"管理知识库",exact:true});await dialog.getByLabel("名称",{exact:true}).fill("重新命名资料");await dialog.getByRole("button",{name:"保存",exact:true}).click();
  await page.getByRole("button",{name:"管理知识库 重新命名资料",exact:true}).click();await dialog.getByRole("button",{name:"权限分配",exact:true}).click();await expect(page.getByRole("dialog",{name:"知识库权限",exact:true})).toContainText(peer.username);
  await page.keyboard.press("Escape");await page.getByRole("button",{name:"管理知识库 重新命名资料",exact:true}).click();await expect(dialog.getByRole("button",{name:"删除知识库",exact:true})).toBeVisible();await dialog.getByRole("button",{name:"删除知识库",exact:true}).click();await expect(page.getByRole("dialog",{name:"确认删除",exact:true})).toBeVisible();
});
test("删除二级目录只上移直接内容，保留正文、历史、权限与子树，普通成员不能删除",async({page,request})=>{
  const {root,owner,peer,book,f1,f2,b}=await fixture(request),db=new Pool({host:"db",user:"anote",database:"anote",password:process.env.DB_PASSWORD});
  try{
    const child=await api(request,"POST",`spaces/${book.id}/folders`,{name:"三级目录",parent_id:f2.id},owner),deep=await api(request,"POST","documents",{space_id:book.id,folder_id:child.id,title:"保留子树内容"},owner);
    const fingerprint=async()=> (await db.query("SELECT (SELECT json_agg(to_jsonb(d)-'folder_id' ORDER BY id) FROM documents d WHERE space_id=$1) AS notes,(SELECT json_agg(v ORDER BY id) FROM document_versions v WHERE doc_id IN(SELECT id FROM documents WHERE space_id=$1)) AS versions",[book.id])).rows[0];const before=await fingerprint();
    await api(request,"DELETE",`spaces/${book.id}/folders/${f2.id}`,undefined,peer,403);await api(request,"DELETE",`spaces/${book.id}/folders/${f2.id}`,undefined,root,403);
    await login(page,owner);await page.goto("/?space="+book.id);await page.getByRole("button",{name:"管理目录 "+f2.name,exact:true}).click();await page.getByRole("button",{name:"删除目录",exact:true}).click();const dialog=page.getByRole("dialog",{name:"删除目录",exact:true});await expect(dialog).toContainText("下级笔记和子目录将移到“目录甲”");await dialog.getByRole("button",{name:"取消",exact:true}).click();expect((await api(request,"GET",`spaces/${book.id}/folders`,undefined,owner)).some((f:any)=>f.id===f2.id)).toBe(true);
    await page.getByRole("button",{name:"管理目录 "+f2.name,exact:true}).click();await page.getByRole("button",{name:"删除目录",exact:true}).click();await dialog.getByRole("button",{name:"确认删除目录",exact:true}).click();await expect(dialog).toHaveCount(0);
    const folders=await api(request,"GET",`spaces/${book.id}/folders`,undefined,owner);expect(folders.some((f:any)=>f.id===f2.id)).toBe(false);expect(folders.find((f:any)=>f.id===child.id).parent_id).toBe(f1.id);expect((await api(request,"GET",`documents/${b.id}`,undefined,owner)).folder_id).toBe(f1.id);expect((await api(request,"GET",`documents/${deep.id}`,undefined,owner)).folder_id).toBe(child.id);expect(await fingerprint()).toEqual(before);
    const list=await api(request,"GET",`spaces/${book.id}/catalog`,undefined,owner);expect(list.items.filter((e:any)=>e.parent_id===f1.id).map((e:any)=>e.key)).toEqual(["note:"+b.id,"folder:"+child.id]);await page.reload();await expect(page.locator(".library-outline")).toContainText(deep.title);await expect(page.locator(".library-outline")).not.toContainText(f2.name);
  }finally{await db.end();}
});

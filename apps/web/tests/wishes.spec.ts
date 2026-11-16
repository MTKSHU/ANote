import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { admin, api, chooseTheme, login, signOutWorkspace } from "./helpers";
import { person } from "./mcp-helpers";
const input = (extra: any = {}) => ({title: "建议 " + randomUUID().slice(0,8), content: "希望编辑体验更顺畅", category: "improvement", anonymous: true, ...extra});
test("许愿池仅登录可用；匿名作者对其他用户不泄露，实名仅展示昵称", async ({ request }) => {
  const guest = await request.get("/api/wishes"); expect(guest.status()).toBe(401);
  expect((await request.post("/api/wishes",{data: input()})).status()).toBe(401);
  expect((await request.delete("/api/wishes/unknown")).status()).toBe(401);
  const owner = await person(request), peer = await person(request), root = await admin(request);
  const name="隐私昵称"+randomUUID().slice(0,5);await api(request,"PATCH","me/profile",{name},owner);
  const wish=await api(request,"POST","wishes",input(),owner);
  const get = async (account: any) => (await api(request,"GET","wishes",undefined,account)).items.find((w:any)=>w.id===wish.id);
  const ordinary=await get(peer);expect(ordinary.author).toBe("匿名用户");expect(ordinary.mine).toBe(false);
  for(const secret of [owner.user.id,owner.username,name])expect(JSON.stringify(ordinary)).not.toContain(secret);
  for(const key of ["created_by","user_id","username","email","author_name","submitter_name"])expect(ordinary).not.toHaveProperty(key);
  expect((await get(owner)).mine).toBe(true);expect((await get(root)).submitter_name).toBe(name);
  const real=await api(request,"POST","wishes",input({anonymous:false}),owner);
  const shown=(await api(request,"GET","wishes",undefined,peer)).items.find((w:any)=>w.id===real.id);expect(shown.author).toBe(name);expect(shown).not.toHaveProperty("created_by");
  await api(request,"POST","wishes",input({anonymous:"true"}),owner,400);
  await api(request,"POST","wishes",input({content:"",title:""}),owner,400);
});
test("普通用户及团队管理员不能处理他人建议；管理员回复状态有冲突保护，撤回和筛选遵守权限", async ({ request }) => {
  const owner=await person(request),other=await person(request),root=await admin(request);
  await api(request,"POST","teams",{name:"建议权限团队"},other);
  const wish=await api(request,"POST","wishes",input(),owner);
  await api(request,"PATCH","wishes/"+wish.id,{status:"completed",reply:"冒充回复",revision:wish.revision},other,403);
  await api(request,"DELETE","wishes/"+wish.id,undefined,other,404);
  const updated=await api(request,"PATCH","wishes/"+wish.id,{status:"planned",reply:"已列入计划",revision:wish.revision},root);expect(updated.revision).toBe(2);
  await api(request,"PATCH","wishes/"+wish.id,{status:"declined",reply:"旧编辑覆盖",revision:wish.revision},root,409);
  const list=await api(request,"GET","wishes?mine=true&status=planned",undefined,owner);expect(list.items).toHaveLength(1);expect(list.items[0].reply).toBe("已列入计划");
  expect((await api(request,"GET","wishes?mine=true",undefined,other)).items).toHaveLength(0);
  await api(request,"DELETE","wishes/"+wish.id,undefined,owner);expect((await api(request,"GET","wishes?mine=true",undefined,owner)).total).toBe(0);
  await api(request,"PATCH","wishes/"+wish.id,{status:"completed",reply:"",revision:2},root,404);
  await api(request,"GET","wishes?page=NaN",undefined,owner,400);await api(request,"GET","wishes?status=unknown",undefined,owner,400);
});
test("匿名表单、明暗主题、本人撤回及管理员处理交互一致", async ({ page, request }) => {
  const owner=await person(request),root=await admin(request),title="界面许愿 "+randomUUID().slice(0,6);
  await login(page,owner);for(const width of [1920,1280]){await page.setViewportSize({width,height:1080});await page.getByRole("link",{name:"首页",exact:true}).click();const geometry=await page.locator(".academic-browser").evaluate(el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el),header=getComputedStyle(el.querySelector("h1")!);return {x:box.x,width:box.width,padding:style.padding,font:header.fontSize,weight:header.fontWeight};});await page.getByRole("link",{name:"许愿池",exact:true}).click();await expect(page.getByRole("heading",{name:"许愿池",exact:true})).toBeVisible();expect(await page.locator(".wishes-page").evaluate(el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el),header=getComputedStyle(el.querySelector("h1")!);return {x:box.x,width:box.width,padding:style.padding,font:header.fontSize,weight:header.fontWeight};})).toEqual(geometry);}
  await chooseTheme(page,"dark");await page.getByRole("button",{name:"提个建议",exact:true}).click();const dialog=page.getByRole("dialog",{name:"提个建议",exact:true});
  await expect(dialog).toContainText("平台管理员仍可追溯提交者");await expect(dialog.getByLabel("匿名展示")).not.toBeChecked();
  await dialog.getByLabel("标题",{exact:true}).fill(title);await dialog.getByLabel("建议内容",{exact:true}).fill('<script>alert("xss")</script>\n让长笔记更好整理');await dialog.getByLabel("匿名展示").check();
  const colors=await dialog.evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));expect(colors.background).not.toBe("rgb(255, 255, 255)");expect(colors.background).not.toBe(colors.color);
  await dialog.getByRole("button",{name:"提交建议",exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole("status").filter({hasText:"建议已提交"})).toBeVisible();
  await page.getByRole("button",{name:"我的建议",exact:true}).click();const card=page.locator(".wish-item").filter({has:page.getByRole("heading",{name:title,exact:true})});await expect(card).toContainText("匿名用户（我）");await expect(card.locator("script")).toHaveCount(0);await expect(card.getByRole("button",{name:"回复与状态"})).toHaveCount(0);
  await page.screenshot({path:"artifacts/web/wishes-dark.png",fullPage:true});
  const footerColor=await page.locator(".wishes-pagination").evaluate(el=>getComputedStyle(el).backgroundColor);expect(footerColor).toBe("rgba(0, 0, 0, 0)");
  await expect(card.getByRole("button",{name:"撤回建议",exact:true})).toHaveCSS("background-color","rgba(0, 0, 0, 0)");
  await chooseTheme(page,"light");await expect(card.locator("h2")).toHaveCSS("color","rgb(36, 40, 51)");
  await signOutWorkspace(page);await login(page);await page.getByRole("link",{name:"许愿池",exact:true}).click();
  const adminCard=page.locator(".wish-item").filter({has:page.getByRole("heading",{name:title,exact:true})});await expect(adminCard).toContainText("仅平台管理员可见");await adminCard.getByRole("button",{name:"回复与状态",exact:true}).click();
  const processing=page.getByRole("dialog",{name:"处理建议",exact:true});await processing.getByRole("combobox",{name:"处理状态",exact:true}).selectOption("in_progress");await processing.getByLabel("管理员回复",{exact:true}).fill("正在优化，感谢建议");await processing.getByRole("button",{name:"保存",exact:true}).click();await expect(adminCard).toContainText("进行中");await expect(adminCard).toContainText("正在优化，感谢建议");
  await adminCard.getByRole("button",{name:"删除建议",exact:true}).click();const deletion=page.getByRole("dialog",{name:"删除建议",exact:true});await expect(deletion).toBeVisible();await page.keyboard.press("Escape");await expect(deletion).toHaveCount(0);await expect(adminCard.getByRole("button",{name:"删除建议",exact:true})).toBeFocused();
  await adminCard.getByRole("button",{name:"删除建议",exact:true}).click();await deletion.getByRole("button",{name:"确认删除",exact:true}).click();await expect(adminCard).toHaveCount(0);
});
test("分页不重复、并发提交按用户限额，普通用户无法伪造状态或作者", async ({ request }) => {
  const owner=await person(request),peer=await person(request);
  const responses=await Promise.all(Array.from({length:25},(_,i)=>request.post("/api/wishes",{headers:{Authorization:"Bearer "+owner.token},data:input({title:"并发建议 "+i,created_by:peer.user.id,status:"completed",reply:"伪造回复"})})));
  expect(responses.filter(r=>r.ok())).toHaveLength(20);expect(responses.filter(r=>r.status()===429)).toHaveLength(5);
  const mine=await api(request,"GET","wishes?mine=true",undefined,owner);expect(mine.total).toBe(20);for(const row of mine.items){expect(row.status).toBe("submitted");expect(row.reply).toBe("");expect(row.mine).toBe(true);}
  expect((await api(request,"GET","wishes?mine=true",undefined,peer)).total).toBe(0);
  await Promise.all(Array.from({length:15},()=>api(request,"POST","wishes",input(),peer)));
  const first=await api(request,"GET","wishes?page=1",undefined,peer);expect(first.items).toHaveLength(30);expect(first.total).toBeGreaterThanOrEqual(35);
  const second=await api(request,"GET","wishes?page=2",undefined,peer);expect(second.items.length).toBeGreaterThan(0);expect(second.items.every((row:any)=>!first.items.some((a:any)=>a.id===row.id))).toBe(true);
});

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { admin, api, login, openWorkspaceSettings, signOutWorkspace } from "./helpers";
import { person } from "./mcp-helpers";
async function policy(request:any,root:any,mode:string){const previous=await api(request,"GET","admin/settings",undefined,root);return api(request,"PATCH","admin/settings",{wish_review_mode:mode,revision:previous.revision},root);}
const wish=()=>({title:"审核愿望 "+randomUUID().slice(0,8),content:"优化使用体验",category:"improvement",anonymous:true});
test("直接显示为默认；审核模式只影响新愿望，未通过内容不会从列表及计数泄露，管理员可删除", async ({ request }) => {
  const root=await admin(request),owner=await person(request),peer=await person(request),config=await api(request,"GET","admin/settings",undefined,root);
  expect(config.wish_review_mode).toBe("direct");
  const publicWish=await api(request,"POST","wishes",wish(),owner);expect(publicWish.moderation_status).toBe("published");
  await api(request,"PATCH","admin/settings",{wish_review_mode:"approval",revision:config.revision},owner,403);
  try {
    await policy(request,root,"approval");const draft=await api(request,"POST","wishes",{...wish(),moderation_status:"published",reviewed_by:root.user.id},owner);expect(draft.moderation_status).toBe("pending");
    const outsiders=await api(request,"GET","wishes?moderation=pending",undefined,peer);expect(outsiders.items).toHaveLength(0);expect(outsiders.total).toBe(0);
    expect((await api(request,"GET","wishes?mine=true&moderation=pending",undefined,owner)).items.map((w:any)=>w.id)).toContain(draft.id);
    await api(request,"PATCH",`wishes/${draft.id}`,{status:"submitted",reply:"",moderation_status:"published",revision:draft.revision},owner,403);
    const approved=await api(request,"PATCH",`wishes/${draft.id}`,{status:"planned",reply:"已通过",moderation_status:"published",revision:draft.revision},root);
    expect((await api(request,"GET","wishes",undefined,peer)).items.map((w:any)=>w.id)).toContain(draft.id);
    const rejected=await api(request,"PATCH",`wishes/${draft.id}`,{status:"planned",reply:"需求已过期",moderation_status:"rejected",revision:approved.revision},root);
    expect((await api(request,"GET","wishes?moderation=rejected",undefined,peer)).total).toBe(0);expect((await api(request,"GET","wishes?mine=true&moderation=rejected",undefined,owner)).items[0].id).toBe(draft.id);
    await policy(request,root,"direct");expect((await api(request,"GET","wishes?mine=true&moderation=rejected",undefined,owner)).items[0].id).toBe(draft.id);
    await api(request,"DELETE",`wishes/${draft.id}`,undefined,root);await api(request,"PATCH",`wishes/${draft.id}`,{status:"planned",reply:"",moderation_status:"published",revision:rejected.revision},root,404);
  } finally {await policy(request,root,config.wish_review_mode);await api(request,"DELETE",`wishes/${publicWish.id}`,undefined,root);}
});
test("平台设置可选择先审核，匿名愿望提交者看到待审核，管理员从界面通过、下架和删除", async ({ page, browser, request }) => {
  const root=await admin(request),owner=await person(request),peer=await person(request),initial=await api(request,"GET","admin/settings",undefined,root),title="界面审核 "+randomUUID().slice(0,8);
  const context=await browser.newContext();
  try {
    await login(page);await openWorkspaceSettings(page);const settings=page.getByRole("dialog",{name:"设置",exact:true});await settings.getByRole("button",{name:"平台管理",exact:true}).click();await settings.getByLabel("愿望展示方式",{exact:true}).selectOption("approval");
    await settings.getByRole("button",{name:"保存平台设置",exact:true}).click();await expect(settings).toContainText("平台设置已保存并生效");await page.keyboard.press("Escape");await signOutWorkspace(page);await login(page,owner);
    await page.getByRole("button",{name:"许愿池",exact:true}).click();await page.getByRole("button",{name:"提个建议",exact:true}).click();const dialog=page.getByRole("dialog",{name:"提个建议",exact:true});await expect(dialog).toContainText("审核通过后向其他用户展示");await dialog.getByLabel("标题",{exact:true}).fill(title);await dialog.getByLabel("建议内容",{exact:true}).fill("优化界面体验");await dialog.getByLabel("匿名展示").check();await dialog.getByRole("button",{name:"提交建议",exact:true}).click();await expect(page.getByRole("status")).toContainText("审核通过后其他用户可见");
    const own=page.locator(".wish-item").filter({has:page.getByRole("heading",{name:title,exact:true})});await expect(own).toContainText("待审核");const record=(await api(request,"GET","wishes?mine=true",undefined,owner)).items.find((w:any)=>w.title===title);expect((await api(request,"GET","wishes",undefined,peer)).items.some((w:any)=>w.id===record.id)).toBe(false);
    const moderator=await context.newPage();await login(moderator);await moderator.getByRole("button",{name:"许愿池",exact:true}).click();await moderator.getByLabel("展示筛选",{exact:true}).selectOption("pending");const card=moderator.locator(".wish-item").filter({has:moderator.getByRole("heading",{name:title,exact:true})});await card.getByRole("button",{name:"回复与状态",exact:true}).click();const edit=moderator.getByRole("dialog",{name:"处理建议",exact:true});await edit.getByLabel("展示状态",{exact:true}).selectOption("published");await edit.getByRole("button",{name:"保存",exact:true}).click();await expect(card).toHaveCount(0);
    expect((await api(request,"GET","wishes",undefined,peer)).items.some((w:any)=>w.id===record.id)).toBe(true);
    await moderator.getByLabel("展示筛选",{exact:true}).selectOption("published");await card.getByRole("button",{name:"回复与状态",exact:true}).click();await edit.getByLabel("展示状态",{exact:true}).selectOption("rejected");await edit.getByRole("button",{name:"保存",exact:true}).click();await moderator.getByLabel("展示筛选",{exact:true}).selectOption("rejected");await expect(card).toContainText("未通过");await card.getByRole("button",{name:"删除建议",exact:true}).click();await moderator.getByRole("dialog",{name:"删除建议",exact:true}).getByRole("button",{name:"确认删除",exact:true}).click();await expect(card).toHaveCount(0);
  } finally {await context.close();await policy(request,root,initial.wish_review_mode);}
});

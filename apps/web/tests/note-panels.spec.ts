import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin,login,typeBody,chooseTheme} from "./helpers";

test("评论和历史使用独立侧栏：互斥替换、再次点击收起、统一关闭并保留草稿",async({page,request})=>{
  const root=await admin(request),username="panel-"+randomUUID().slice(0,8),password="Note-panels-test-123!";
  await api(request,"POST","users",{username,password,name:"侧栏验证"},root);
  const owner={...await api(request,"POST","auth/login",{username,password}),username,password};
  const book=await api(request,"POST","spaces",{name:"侧栏规则",kind:"personal"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"独立侧栏"},owner);
  await login(page,owner);await page.goto("/?doc="+note.id);await typeBody(page,"在段落旁记录评论，查看笔记历史。");
  const commentsButton=page.locator(".document-actions").getByRole("button",{name:"评论",exact:true}),historyButton=page.locator(".document-actions").getByRole("button",{name:"历史版本",exact:true}),comments=page.getByRole("complementary",{name:"正文评论",exact:true}),history=page.getByRole("complementary",{name:"历史版本",exact:true});
  for(const theme of ["light","dark"] as const){
    await chooseTheme(page,theme);await commentsButton.click();await expect(comments).toBeVisible();await expect(page.locator(".inspector")).toHaveCount(1);await expect(comments.locator(".note-panel-header strong")).toContainText("评论");await expect(comments.getByRole("button",{name:"历史版本",exact:true})).toHaveCount(0);
    if(!await page.getByLabel("评论内容",{exact:true}).count())await comments.getByRole("button",{name:"新建批注",exact:true}).click();
    await page.getByLabel("评论内容",{exact:true}).fill("切换时保留的评论草稿");
    await historyButton.click();await expect(history).toBeVisible();await expect(comments).toHaveCount(0);await expect(page.locator(".inspector")).toHaveCount(1);await expect(history.getByRole("button",{name:/^(评论|本地同步)$/})).toHaveCount(0);await expect(page.locator(".inspector-tabs")).toHaveCount(0);
    await page.getByRole("tab",{name:"命名版本",exact:true}).click();await page.getByLabel("版本号",{exact:true}).fill("v1.0");await page.getByLabel("版本说明",{exact:true}).fill("切换时保留的版本说明");
    await historyButton.click();await expect(history).toHaveCount(0);await historyButton.click();await expect(page.getByLabel("版本说明",{exact:true})).toHaveValue("切换时保留的版本说明");
    await commentsButton.click();await expect(history).toHaveCount(0);await expect(page.getByLabel("评论内容",{exact:true})).toHaveValue("切换时保留的评论草稿");
    await expect(comments.locator(".note-panel-header")).toHaveCSS("height","48px");await expect(comments.locator(".note-panel-close")).toHaveCSS("width","32px");
    await page.screenshot({path:`artifacts/web/note-panel-comments-${theme}.png`,animations:"disabled"});
    await commentsButton.click();await expect(comments).toHaveCount(0);await commentsButton.click();await expect(page.getByLabel("评论内容",{exact:true})).toHaveValue("切换时保留的评论草稿");
    await comments.getByRole("button",{name:"收起侧栏",exact:true}).click();await expect(page.locator(".inspector")).toHaveCount(0);
    await historyButton.click();await history.getByRole("button",{name:"收起侧栏",exact:true}).click();await expect(page.locator(".inspector")).toHaveCount(0);
  }
});

import { test, expect } from "@playwright/test";
import { admin, api, login } from "./helpers";
import { person } from "./mcp-helpers";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import * as Y from "yjs";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import {canonical,schema} from "@anote/document-model";

test.beforeAll(async({request})=>{
  expect(process.env.BASE_URL).toBe("http://anote.internal:3000");
  const owner=await admin(request),db=new Pool({host:"db",user:"anote",database:"anote",password:process.env.DB_PASSWORD});
  try{
    const space=randomUUID(),id=randomUUID(),snapshot=canonical({type:"doc",content:[{type:"heading",attrs:{blockId:randomUUID(),level:2},content:[{type:"text",text:"管理员实测的接入说明"}]},{type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text:"该段仅用于隔离测试，检查原文复制与教程标签。"}]}]}),doc=prosemirrorJSONToYDoc(schema,snapshot,"default");
    await db.query("INSERT INTO spaces(id,name,kind,created_by,access_mode) VALUES($1,'MCP 教程测试来源','personal',$2,'restricted')",[space,owner.user.id]);await db.query("INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'admin')",[space,owner.user.id]);
    try{await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate,visibility,tags) VALUES($1,$2,'ChatGPT 连接与使用 ANote MCP',$3,$4,$5,'private',ARRAY['平台入门教程'])",[id,space,owner.user.id,snapshot,Buffer.from(Y.encodeStateAsUpdate(doc))]);}finally{doc.destroy();}
    await db.query("UPDATE onboarding_guide_templates SET configured=true,source_doc_id=$1 WHERE guide_key='chatgpt-mcp'",[id]);
  }finally{await db.end();}
});

test("外部只读页展示自定义平台 Logo，未登录与已登录访问均可直接返回首页", async ({ page, browser, request }) => {
  const root=await admin(request),owner=await person(request),before=await api(request,"GET","admin/settings",undefined,root);
  await api(request,"PATCH","admin/settings",{site_name:"ANote 展示测试",revision:before.revision},root);
  try {
    const book=(await api(request,"GET","spaces",undefined,owner)).find((s:any)=>s.name==="默认知识库" && s.kind==="personal");expect(book).toBeTruthy();
    const note=await api(request,"POST","documents",{space_id:book.id,title:"公开品牌入口测试"},owner),link=await api(request,"POST",`documents/${note.id}/sharing/links`,{days:null},owner);
    for (const theme of ["light","dark"] as const) {
      const context=await browser.newContext({colorScheme:theme});
      try {
        const guest=await context.newPage();await guest.goto(link.path);const home=guest.getByRole("link",{name:"ANote 展示测试首页",exact:true});await expect(home).toBeVisible();await expect(home).toHaveAttribute("href","/");await expect(home.locator("svg")).toHaveCount(1);
        await expect(guest.locator("html")).toHaveAttribute("data-theme",theme);await expect(guest.getByTestId("editor")).toHaveAttribute("contenteditable","false");
        const colors=await home.evaluate(el=>({text:getComputedStyle(el).color,background:getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()}));expect(colors.text).not.toBe(colors.background);if(theme==="dark")await expect(home).toHaveCSS("color","rgb(229, 233, 240)");
        await guest.screenshot({path:`artifacts/web/public-home-${theme}.png`,fullPage:true});await home.click();await expect(guest).toHaveURL(/\/$/);await expect(guest.getByLabel("用户名",{exact:true})).toBeVisible();
      } finally {await context.close();}
    }
    await login(page,owner);await page.goto(link.path);await page.getByRole("link",{name:"ANote 展示测试首页",exact:true}).click();await expect(page.getByRole("heading",{name:"首页",exact:true})).toBeVisible();
  } finally {const current=await api(request,"GET","admin/settings",undefined,root);await api(request,"PATCH","admin/settings",{site_name:before.site_name,revision:current.revision},root);}
});
test("首次登录初始化默认个人知识库；重复会话及重新登录不会重复，也不复活删除的默认库", async ({ page, request }) => {
  const account=await person(request),first=await api(request,"GET","spaces",undefined,account),books=first.filter((s:any)=>s.kind==="personal" && s.name==="默认知识库");expect(books).toHaveLength(1);expect(books[0].created_by).toBe(account.user.id);expect(books[0].sidebar_pinned).toBe(true);
  const guideTitle="ChatGPT 连接与使用 ANote MCP",notes=await api(request,"GET","documents?space_id="+books[0].id,undefined,account),guide=notes.find((n:any)=>n.title===guideTitle);expect(guide).toBeTruthy();expect(guide.created_by).toBe(account.user.id);expect(guide.visibility).toBe("private");
  await Promise.all(Array.from({length:5},()=>api(request,"GET","auth/session",undefined,account)));expect((await api(request,"GET","spaces",undefined,account)).filter((s:any)=>s.name==="默认知识库")).toHaveLength(1);
  await login(page,account);await page.getByTestId("personal-libraries").click();await expect(page.locator(".library-card").filter({has:page.getByRole("heading",{name:"默认知识库",exact:true})})).toBeVisible();
  expect(guide.tags).toContain("平台入门教程");await page.goto("/?doc="+guide.id);await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(guideTitle);await expect(page.getByTestId("editor")).toContainText("管理员实测的接入说明");
  expect((await api(request,"GET","documents?space_id="+books[0].id,undefined,account)).filter((n:any)=>n.title===guideTitle)).toHaveLength(1);
  await api(request,"DELETE",`spaces/${books[0].id}`,undefined,account);await api(request,"GET","auth/session",undefined,account);expect((await api(request,"GET","spaces",undefined,account)).filter((s:any)=>s.name==="默认知识库")).toHaveLength(0);
});

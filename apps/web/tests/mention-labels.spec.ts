import {test,expect,type APIRequestContext} from "@playwright/test";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {api,admin,login,chooseTheme} from "./helpers";

async function fixture(request:APIRequestContext) {
  const root=await admin(request),password="Mention-labels-test-123!";
  async function person(name:string){const username="labels-"+randomUUID().slice(0,8);await api(request,"POST","users",{username,password,name},root);return {...await api(request,"POST","auth/login",{username,password}),username,password};}
  const owner=await person("笔记作者"),first=await person("李晓明（视觉组）"),second=await person("李晓明（视觉组）"),local=await person("本地同学"),noEmail=await person("统一认证同学"),stranger=await person("无关成员");
  const suffix=randomUUID().slice(0,8),firstEmail=`researcher-${suffix}@lab.example.test`,secondEmail=`long-researcher-${suffix}-${"a".repeat(55)}@lab.example.test`,strangerEmail=`private-${suffix}@example.test`,unverifiedEmail=`unverified-${suffix}@example.test`;
  const sql=new Pool({host:"db",user:"anote",database:"anote",password:process.env.DB_PASSWORD});
  try {for(const [account,email,verified,sso] of [[first,firstEmail,true,true],[second,secondEmail,true,true],[local,unverifiedEmail,false,false],[noEmail,null,false,true],[stranger,strangerEmail,true,true]] as const)
    await sql.query("UPDATE users SET email=$2,email_verified=$3,username=$4 WHERE id=$1",[account.user.id,email,verified,sso?"sso-"+account.user.id:account.username]);
  } finally {await sql.end();}
  const team=await api(request,"POST","teams",{name:"提及显示团队"},owner),invite=await api(request,"POST",`teams/${team.id}/invites`,{},owner);
  for(const member of [first,second,local,noEmail])await api(request,"POST",`team-invitations/${new URL(invite.path,"http://test").searchParams.get("invite")}/accept`,{},member);
  const book=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"研究资料"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"提及显示测试"},owner);
  return {owner,first,second,local,noEmail,stranger,firstEmail,secondEmail,strangerEmail,unverifiedEmail,note};
}

test("提及邮箱仅限已验证且在团队／好友范围内，支持完整邮箱筛选",async({request})=>{
  const f=await fixture(request),path=`documents/${f.note.id}/mention-candidates`;
  const candidates=await api(request,"GET",path,undefined,f.owner);expect(candidates).toHaveLength(4);expect(candidates.find((c:any)=>c.id===f.first.user.id).email).toBe(f.firstEmail);expect(candidates.find((c:any)=>c.id===f.local.user.id).email).toBeNull();expect(JSON.stringify(candidates)).not.toContain(f.strangerEmail);
  expect((await api(request,"GET",path+"?q="+encodeURIComponent(f.firstEmail.toUpperCase()),undefined,f.owner)).map((c:any)=>c.id)).toEqual([f.first.user.id]);
  expect(await api(request,"GET",path+"?q="+f.strangerEmail,undefined,f.owner)).toEqual([]);expect(await api(request,"GET",path+"?q="+f.unverifiedEmail,undefined,f.owner)).toEqual([]);await api(request,"GET",path,undefined,f.stranger,403);
  const book=await api(request,"POST","spaces",{kind:"personal",name:"私人资料"},f.owner),note=await api(request,"POST","documents",{space_id:book.id,title:"个人提及"},f.owner),personal=`documents/${note.id}/mention-candidates?q=`+encodeURIComponent(f.firstEmail);
  expect(await api(request,"GET",personal,undefined,f.owner)).toEqual([]);await api(request,"POST","friend-requests",{account:f.firstEmail},f.owner);const link=(await api(request,"GET","friends",undefined,f.first))[0];await api(request,"PATCH",`friend-requests/${link.id}`,{action:"accept"},f.first);expect((await api(request,"GET",personal,undefined,f.owner)).map((c:any)=>c.id)).toEqual([f.first.user.id]);
  await api(request,"DELETE",`friends/${link.id}`,undefined,f.owner);expect(await api(request,"GET",personal,undefined,f.owner)).toEqual([]);
});

test("候选昵称和邮箱分行，隐藏内部 SSO 标识，长邮箱不挤压昵称，选择只插入昵称",async({page,request})=>{
  const f=await fixture(request);await login(page,f.owner);await page.goto("/?doc="+f.note.id);const editor=page.getByTestId("editor"),list=page.getByRole("listbox",{name:"提及成员或好友"});
  async function open(query=""){await editor.evaluate(dom=>{const e=(dom as any).editor;e.commands.clearContent();e.commands.focus("end");});await expect(editor).toBeFocused();await page.keyboard.insertText("@"+query);await expect(list).toBeVisible();}
  for(const theme of ["light","dark"] as const) {
    await chooseTheme(page,theme);await expect(page.locator("html")).not.toHaveClass(/theme-changing/);await open();await expect(list.getByRole("option")).toHaveCount(4);await expect(list).not.toContainText("sso-");await expect(list).not.toContainText(f.unverifiedEmail);
    const email=list.getByRole("option").filter({hasText:f.secondEmail}),local=list.getByRole("option").filter({hasText:"本地同学"}),noEmail=list.getByRole("option").filter({hasText:"统一认证同学"});
    await expect(email.locator("strong")).toHaveText("李晓明（视觉组）");await expect(email.locator("small")).toHaveText(f.secondEmail);await expect(email).toHaveAttribute("title","李晓明（视觉组） · "+f.secondEmail);await expect(local.locator("small")).toHaveText("@"+f.local.username);await expect(noEmail.locator("small")).toHaveCount(0);
    const geometry=await email.evaluate(el=>{const name=el.querySelector("strong")!,email=el.querySelector("small")!;return {nameWidth:name.clientWidth,nameOverflow:name.scrollWidth>name.clientWidth,nameY:name.getBoundingClientRect().y,emailY:email.getBoundingClientRect().y,emailOverflow:email.scrollWidth>email.clientWidth};});expect(geometry.nameWidth).toBeGreaterThan(280);expect(geometry.nameOverflow).toBe(false);expect(geometry.emailY).toBeGreaterThan(geometry.nameY);expect(geometry.emailOverflow).toBe(true);
    await list.screenshot({path:`artifacts/web/mention-labels-${theme}.png`});await page.keyboard.press("Escape");
  }
  await open(f.firstEmail);await expect(list.getByRole("option")).toHaveCount(1);await page.keyboard.press("Enter");await expect(editor.locator(".user-mention")).toHaveText("@李晓明（视觉组）");await expect(editor).not.toContainText(f.firstEmail);await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存");expect((await api(request,"GET","notifications",undefined,f.first)).items.some((n:any)=>n.kind==="mention")).toBe(true);
  await page.setViewportSize({width:360,height:780});await open();await expect(list.getByRole("option")).toHaveCount(4);const bounds=(await list.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(8);expect(bounds.x+bounds.width).toBeLessThanOrEqual(352);await page.keyboard.press("Escape");
  await editor.evaluate(dom=>{const e=(dom as any).editor;e.commands.clearContent();e.commands.focus("end");});await expect(editor).toBeFocused();await page.keyboard.insertText("someone@example.test");await expect(list).toHaveCount(0);
});

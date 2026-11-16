import {test,expect,type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {api,admin,login,chooseTheme,openWorkspaceSwitcher} from "./helpers";

async function person(request:APIRequestContext,name:string,verified=true) {
  const root=await admin(request),username="invited-"+randomUUID().slice(0,8),password="Invite-notification-fixture-123!",email=username+"@example.test";
  await api(request,"POST","users",{username,password,name},root);const account=await api(request,"POST","auth/login",{username,password});
  await api(request,"PATCH",`team/members/${account.user.id}`,{email,email_verified:verified},root);
  return {...account,username,password,email};
}
async function fixture(request:APIRequestContext) {
  const owner=await person(request,"邀请管理员"),recipient=await person(request,"被邀请用户"),stranger=await person(request,"无关用户"),team=await api(request,"POST","teams",{name:"邮箱邀请团队"},owner);
  return {owner,recipient,stranger,team};
}
const token=(invitation:any)=>new URL(invitation.path,"http://test").searchParams.get("invite");
const notifications=(request:APIRequestContext,account:any)=>api(request,"GET","notifications",undefined,account);

test("已验证注册邮箱收到绑定账号的邀请通知，可接受并幂等重试，移除后旧邀请不能再次入队",async({request})=>{
  const f=await fixture(request),invitation=await api(request,"POST",`teams/${f.team.id}/invites`,{email:f.recipient.email.toUpperCase()},f.owner),messages=await notifications(request,f.recipient),notice=messages.items.find((item:any)=>item.kind==="team_invite");
  expect(notice).toMatchObject({team_name:f.team.name,actor_name:f.owner.user.name,invite_status:"pending"});expect(notice.invite_expires_at).toBeTruthy();expect(JSON.stringify(messages)).not.toContain(token(invitation)!);expect(JSON.stringify(messages)).not.toContain("token_hash");expect((await api(request,"GET","social/badges",undefined,f.recipient)).unread).toBe(1);expect((await notifications(request,f.stranger)).items).toEqual([]);
  await api(request,"PATCH",`team-invitation-notifications/${notice.id}`,{action:"accept"},f.stranger,404);await api(request,"GET",`team-invitations/${token(invitation)}`,undefined,f.stranger,404);await api(request,"POST",`team-invitations/${token(invitation)}/accept`,{},f.stranger,403);
  const accepted=await Promise.all([1,2].map(()=>api(request,"PATCH",`team-invitation-notifications/${notice.id}`,{action:"accept"},f.recipient)));expect(accepted).toEqual([{team_id:f.team.id},{team_id:f.team.id}]);
  const team=await api(request,"GET",`teams/${f.team.id}`,undefined,f.owner);expect(team.members.filter((member:any)=>member.id===f.recipient.user.id)).toHaveLength(1);expect(team.invites[0].acceptance_count).toBe(1);expect((await notifications(request,f.recipient)).items[0]).toMatchObject({invite_status:"accepted"});expect((await api(request,"GET","social/badges",undefined,f.recipient)).unread).toBe(0);await api(request,"POST",`team-invitations/${token(invitation)}/accept`,{},f.recipient,404);
  await api(request,"POST",`teams/${f.team.id}/members`,{user_id:f.recipient.user.id,role:null},f.owner);await api(request,"PATCH",`team-invitation-notifications/${notice.id}`,{action:"accept"},f.recipient,404);expect((await notifications(request,f.recipient)).items[0].invite_status).toBe("unavailable");
});

test("拒绝、撤销、过期及团队归档会关闭站内邀请；仅本人能处理且邮箱变更不转移给新账号",async({request})=>{
  const f=await fixture(request);let sequence=0;
  async function invitation(){const team=await api(request,"POST","teams",{name:"邀请状态 "+sequence++},f.owner),link=await api(request,"POST",`teams/${team.id}/invites`,{email:f.recipient.email},f.owner),notice=(await notifications(request,f.recipient)).items.find((item:any)=>item.team_name===team.name);return {team,link,notice};}
  const rejected=await invitation();await api(request,"PATCH",`team-invitation-notifications/${rejected.notice.id}`,{action:"reject"},f.owner,404);await api(request,"PATCH",`team-invitation-notifications/${rejected.notice.id}`,{action:"reject"},f.recipient);await api(request,"PATCH",`team-invitation-notifications/${rejected.notice.id}`,{action:"accept"},f.recipient,404);await api(request,"POST",`team-invitations/${token(rejected.link)}/accept`,{},f.recipient,404);
  const revoked=await invitation();await api(request,"DELETE",`teams/${revoked.team.id}/invites/${revoked.link.id}`,undefined,f.owner);await api(request,"PATCH",`team-invitation-notifications/${revoked.notice.id}`,{action:"accept"},f.recipient,404);
  const expired=await invitation(),db=new Pool({host:"db",database:"anote",user:"anote",password:process.env.DB_PASSWORD});try{await db.query("UPDATE team_invites SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.link.id]);}finally{await db.end();}await api(request,"PATCH",`team-invitation-notifications/${expired.notice.id}`,{action:"accept"},f.recipient,404);
  const archived=await invitation();await api(request,"PATCH",`teams/${archived.team.id}`,{archived:true},f.owner);await api(request,"PATCH",`team-invitation-notifications/${archived.notice.id}`,{action:"accept"},f.recipient,404);
  const deleted=await invitation();await api(request,"DELETE",`teams/${deleted.team.id}`,undefined,f.owner);await api(request,"PATCH",`team-invitation-notifications/${deleted.notice.id}`,{action:"accept"},f.recipient,404);await api(request,"POST",`teams/${deleted.team.id}/restore-deleted`,{},f.owner);await api(request,"PATCH",`team-invitation-notifications/${deleted.notice.id}`,{action:"accept"},f.recipient,404);
  const states=(await notifications(request,f.recipient)).items;expect(states.find((item:any)=>item.id===rejected.notice.id).invite_status).toBe("rejected");expect(states.find((item:any)=>item.id===revoked.notice.id).invite_status).toBe("revoked");expect(states.find((item:any)=>item.id===expired.notice.id).invite_status).toBe("expired");expect(states.find((item:any)=>item.id===archived.notice.id).invite_status).toBe("unavailable");
  const bound=await invitation(),root=await admin(request);await api(request,"PATCH",`team/members/${f.recipient.user.id}`,{email:"new-"+f.recipient.email,email_verified:true},root);await api(request,"PATCH",`team/members/${f.stranger.user.id}`,{email:f.recipient.email,email_verified:true},root);await api(request,"POST",`team-invitations/${token(bound.link)}/accept`,{},f.stranger,403);await api(request,"PATCH",`team-invitation-notifications/${bound.notice.id}`,{action:"accept"},f.recipient,403);
});

test("未知或未验证邮箱不枚举账号、不发通知，通用多人邀请继续可用",async({request})=>{
  const f=await fixture(request),unverified=await person(request,"邮箱尚未验证",false),known=await api(request,"POST",`teams/${f.team.id}/invites`,{email:f.recipient.email},f.owner),unknown=await api(request,"POST",`teams/${f.team.id}/invites`,{email:randomUUID()+"@example.test"},f.owner),untrusted=await api(request,"POST",`teams/${f.team.id}/invites`,{email:unverified.email},f.owner);
  expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());expect(known).not.toHaveProperty("target_user_id");expect((await notifications(request,unverified)).items).toEqual([]);await api(request,"POST",`team-invitations/${token(untrusted)}/accept`,{},unverified,403);
  const general=await api(request,"POST",`teams/${f.team.id}/invites`,{},f.owner);expect(general.reusable).toBe(true);await api(request,"POST",`team-invitations/${token(general)}/accept`,{},f.stranger);await api(request,"POST",`team-invitations/${token(general)}/accept`,{},unverified);expect((await api(request,"GET",`teams/${f.team.id}`,undefined,f.owner)).members).toHaveLength(3);
});

test("管理员填写注册邮箱发送，接收者在通知页接受后团队出现在用户名菜单，明暗主题保持一致",async({request,page,browser})=>{
  const f=await fixture(request);await login(page,f.owner);await page.goto(`/?team=${f.team.id}&view=members`);await page.getByLabel("邀请邮箱",{exact:true}).fill(f.recipient.email);await page.getByRole("button",{name:"发送邀请",exact:true}).click();await expect(page.getByRole("status")).toContainText("对方会收到站内邀请通知");await expect(page.getByLabel("团队邀请链接",{exact:true})).not.toHaveValue("");
  const context=await browser.newContext(),recipientPage=await context.newPage();try{await login(recipientPage,f.recipient);await recipientPage.getByRole("link",{name:"消息通知",exact:true}).click();const notice=recipientPage.locator(".notification-row").filter({hasText:f.team.name});await expect(notice).toContainText("邀请你加入团队");await expect(notice.getByRole("button",{name:"接受邀请",exact:true})).toBeVisible();
    for(const theme of ["light","dark"] as const){await chooseTheme(recipientPage,theme);await expect(recipientPage.locator("html")).not.toHaveClass(/theme-changing/);await notice.screenshot({path:`artifacts/web/team-invite-notification-${theme}.png`});}
    await notice.getByRole("button",{name:"接受邀请",exact:true}).click();await expect(notice).toContainText("已加入团队");await expect(notice.getByRole("button",{name:"接受邀请",exact:true})).toHaveCount(0);await openWorkspaceSwitcher(recipientPage);await expect(recipientPage.getByRole("menuitemradio",{name:f.team.name,exact:true})).toBeVisible();
  }finally{await context.close();}
});

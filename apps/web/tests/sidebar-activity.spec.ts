import {test,expect,type APIRequestContext,type Page} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {api,admin,login,typeBody,chooseTheme,removeEmptyDefaultLibrary,switchWorkspace} from "./helpers";
const password="Active-sidebar-test-123!";
async function person(request:APIRequestContext,root:any){const username="active-"+randomUUID().slice(0,8);await api(request,"POST","users",{username,password,name:username},root);const account={...await api(request,"POST","auth/login",{username,password}),username,password};await removeEmptyDefaultLibrary(request,account);return account;}
async function book(request:APIRequestContext,owner:any,name:string,team?:any,access_mode="team"){return api(request,"POST","spaces",{name,kind:team?"team":"personal",team_id:team?.id,access_mode},owner);}
async function note(request:APIRequestContext,owner:any,space:any,index:number,visibility="team"){
  const value=await api(request,"POST","documents",{space_id:space.id,title:space.name+"笔记",visibility:space.kind==="personal"?"private":visibility},owner);
  await dated(value.id,index);return value;
}
async function dated(id:string,index:number){const db=new Pool({host:"db",user:"anote",database:"anote",password:process.env.DB_PASSWORD});try{await db.query("UPDATE documents SET updated_at=$2 WHERE id=$1",[id,new Date(Date.UTC(2020,0,1+index)).toISOString()]);}finally{await db.end();}}
const group=(page:Page,id="personal")=>page.locator('.academic-sidebar [data-sidebar-group="'+id+'"]');
const allLibraries=(page:Page)=>page.getByRole('navigation',{name:'知识库导航',exact:true}).getByRole('link',{name:'全部知识库',exact:true});

test("当前空间最多三个知识库，固定先后优先再按最近笔记补足，六个固定保留设置并在全部知识库访问",async({page,request})=>{
  const root=await admin(request),owner=await person(request,root),personal=[],a=[],teamA=await api(request,"POST","teams",{name:"活跃 A"},owner),teamB=await api(request,"POST","teams",{name:"活跃 B"},owner);
  for(let i=0;i<7;i++){const b=await book(request,owner,"个人资料"+i);personal.push(b);await note(request,owner,b,i);}
  for(const index of [0,2,6])for(let extra=0;extra<3;extra++)await note(request,owner,personal[index],10+extra);
  for(let i=0;i<6;i++){const b=await book(request,owner,"团队资料"+i,teamA);a.push(b);await note(request,owner,b,i);}
  const b=await book(request,owner,"B 资料",teamB);await note(request,owner,b,1);await book(request,owner,"空知识库");const archived=await book(request,owner,"只有归档笔记"),archivedNote=await note(request,owner,archived,100);await api(request,"PATCH",`documents/${archivedNote.id}`,{archived:true},owner);
  const pin=async(id:string,on=true)=>api(request,"PATCH",`spaces/${id}/sidebar-pin`,{pinned:on},owner);
  const first=await pin(personal[0].id);await pin(personal[2].id);expect((await pin(personal[0].id)).sidebar_pinned_at).toBe(first.sidebar_pinned_at);await pin(a[0].id);await pin(a[2].id);await api(request,"PATCH",`spaces/${a[2].id}`,{pinned:true},owner);
  await login(page,owner);const expected=[0,2,6].map(i=>personal[i].name);await expect(group(page).locator('.sidebar-library')).toHaveText(expected);await expect(group(page).locator('.sidebar-library-note')).toHaveCount(9);for(const section of await group(page).locator('.sidebar-book').all())await expect(section.locator('.sidebar-library-note')).toHaveCount(3);await expect(page.locator('.academic-sidebar')).not.toContainText('空知识库');await expect(page.locator('.academic-sidebar')).not.toContainText(archived.name);
  await switchWorkspace(page,teamA.name);await expect(group(page,teamA.id).locator('.sidebar-library')).toHaveText([0,2,5].map(i=>a[i].name));await expect(group(page)).toHaveCount(0);await switchWorkspace(page,teamB.name);await expect(group(page,teamB.id).locator('.sidebar-library')).toHaveText([b.name]);await switchWorkspace(page,'个人');await expect(group(page).locator('.sidebar-library')).toHaveText(expected);
  for(const theme of ["light","dark"] as const){await chooseTheme(page,theme);await page.screenshot({path:`artifacts/web/sidebar-activity-${theme}.png`,animations:"disabled"});await page.setViewportSize({width:1000,height:650});await expect(group(page).locator('.sidebar-library')).toHaveText(expected);await page.setViewportSize({width:1580,height:1150});}
  for(const index of [1,3,4,5])await pin(personal[index].id);await page.reload();await expect(group(page).locator('.sidebar-library')).toHaveText([0,2,1].map(i=>personal[i].name));await expect(group(page).locator('.sidebar-pin[aria-pressed="true"]')).toHaveCount(3);expect((await api(request,'GET','spaces',undefined,owner)).filter((value:any)=>value.kind==='personal'&&value.sidebar_pinned)).toHaveLength(6);
  await allLibraries(page).click();await expect(page.locator('.library-card')).toHaveCount(9);await expect(page.locator('.library-card .sidebar-pin[aria-pressed="true"]')).toHaveCount(6);await expect(page.locator('.library-card').filter({hasText:personal[5].name})).toBeVisible();
  await pin(personal[0].id,false);await page.reload();await expect(group(page).locator('.sidebar-library')).toHaveText([2,1,3].map(i=>personal[i].name));
  await switchWorkspace(page,teamA.name);await allLibraries(page).click();await expect(page.locator('.library-card')).toHaveCount(6);
});

test("编辑中的更新和后台刷新不改变活跃顺序，返回首页或刷新页面后更新且保留正文",async({page,request})=>{
  const root=await admin(request),owner=await person(request,root),books=[],notes=[];for(let i=0;i<6;i++){const b=await book(request,owner,"稳定资料"+i);books.push(b);notes.push(await note(request,owner,b,i));}
  await login(page,owner);await page.goto('/?doc='+notes[5].id);const items=group(page).locator('.sidebar-library'),before=[5,4,3].map(i=>books[i].name);await expect(items).toHaveText(before);await expect(page.getByTestId('editor')).toBeVisible();await page.getByTestId('editor').evaluate(el=>el.dataset.activityCheck='retained');await typeBody(page,'活跃排序不能打断编辑。');await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');
  await dated(notes[0].id,30000);books[5].name+='已刷新';await api(request,'PATCH',`spaces/${books[5].id}`,{name:books[5].name},owner);await page.evaluate(()=>window.dispatchEvent(new Event('anote-note-changed')));await expect(items).toHaveText([5,4,3].map(i=>books[i].name));await expect(page.getByTestId('editor')).toHaveAttribute('data-activity-check','retained');
  await page.locator('.academic-navigation').getByRole('link',{name:'首页',exact:true}).click();await expect(items).toHaveText([0,5,4].map(i=>books[i].name));await page.goto('/?doc='+notes[5].id);await expect(items).toHaveText([0,5,4].map(i=>books[i].name));await expect(page.getByTestId('editor')).toContainText('活跃排序不能打断编辑。');
});

test("活跃度只计算可读笔记，私有内容不影响排名，编辑时权限撤销立即移除，固定设置按账号隔离",async({page,request})=>{
  const root=await admin(request),owner=await person(request,root),peer=await person(request,root),team=await api(request,"POST","teams",{name:"权限活跃组"},owner),invite=await api(request,"POST",`teams/${team.id}/invites`,{},owner);await api(request,"POST",`team-invitations/${new URL(invite.path,'http://test').searchParams.get('invite')}/accept`,{},peer);
  const x=await book(request,owner,'公开资料 X',team),y=await book(request,owner,'公开资料 Y',team),z=await book(request,owner,'仅有私有笔记',team),restricted=await book(request,owner,'受限知识库',team,'restricted'),mine=await book(request,peer,'自己的研究');const publicX=await note(request,owner,x,0);await note(request,owner,x,30000,'private');await note(request,owner,y,1);await note(request,owner,z,30000,'private');await note(request,owner,restricted,30000);const ownNote=await note(request,peer,mine,1);await api(request,'PATCH',`spaces/${x.id}/sidebar-pin`,{pinned:true},owner);
  await login(page,peer);await switchWorkspace(page,team.name);await group(page,team.id).getByRole('link',{name:y.name,exact:true}).click();await page.locator('.note-open').first().click();const section=group(page,team.id);await expect(page.getByTestId('editor')).toBeVisible();await expect(section.locator('.sidebar-library')).toHaveText([y.name,x.name]);await expect(section.getByRole('button',{name:'固定到侧栏 '+x.name,exact:true})).toHaveAttribute('aria-pressed','false');await expect(page.locator('.academic-sidebar')).not.toContainText(restricted.name);await expect(page.locator('.academic-sidebar')).not.toContainText(z.name);
  const sharing=await api(request,'GET',`documents/${publicX.id}/sharing`,undefined,owner);await api(request,'PATCH',`documents/${publicX.id}/sharing`,{visibility:'private',collaborators:[],access_revision:sharing.access_revision},owner);await page.evaluate(()=>window.dispatchEvent(new Event('anote-note-changed')));await expect(section.locator('.sidebar-library')).toHaveText([y.name]);await expect(page.getByTestId('editor')).toBeVisible();
  await page.goto('/?doc='+ownNote.id);await expect(group(page).locator('.sidebar-library')).toHaveText([mine.name]);await api(request,'POST',`teams/${team.id}/members`,{user_id:peer.user.id,role:null},owner);await page.evaluate(()=>window.dispatchEvent(new Event('anote-note-changed')));await expect(section).toHaveCount(0);await expect(group(page).locator('.sidebar-library')).toHaveText([mine.name]);
});

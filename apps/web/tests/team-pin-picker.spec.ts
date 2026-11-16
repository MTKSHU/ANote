import {test,expect,type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {api,admin,login,chooseTheme} from "./helpers";
async function fixture(request:APIRequestContext){
  const root=await admin(request),username="pins-"+randomUUID().slice(0,8),password="Team-pins-test-123!";
  await api(request,"POST","users",{username,password,name:"置顶管理员"},root);const owner={...await api(request,"POST","auth/login",{username,password}),username,password},team=await api(request,"POST","teams",{name:"置顶搜索团队"},owner),book=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"研究资料"},owner),notes=[];
  for(const title of ["ANote 入门教程","本周实验记录","研究规范说明","课题组会议记录","后续课题规划"])notes.push(await api(request,"POST","documents",{space_id:book.id,title},owner));
  return {owner,team,book,notes};
}
test("团队置顶最多三篇且包含公告，旧超限配置按原顺序展示，普通更新可保存而不删除笔记",async({request})=>{
  const {owner,team,notes}=await fixture(request),ids=notes.map(note=>note.id);
  await api(request,"PATCH",`teams/${team.id}`,{pinned_note_ids:ids.slice(0,4)},owner,400);
  await api(request,"PATCH",`teams/${team.id}`,{pinned_note_ids:ids.slice(0,3)},owner);
  await api(request,"PATCH",`teams/${team.id}`,{announcement_doc_id:ids[3]},owner,400);
  await api(request,"PATCH",`teams/${team.id}`,{announcement_doc_id:ids[0]},owner);const announced=await api(request,"GET",`teams/${team.id}`,undefined,owner);expect(announced.pinned_note_ids).toEqual(ids.slice(1,3));expect(announced.pinned_note_summaries).toHaveLength(3);
  const db=new Pool({connectionString:`postgres://anote:${process.env.DB_PASSWORD}@db:5432/anote`});try{await db.query("UPDATE teams SET announcement_doc_id=NULL,pinned_note_ids=$2 WHERE id=$1",[team.id,ids]);}finally{await db.end();}
  const legacy=await api(request,"GET",`teams/${team.id}`,undefined,owner);expect(legacy.pinned_note_ids).toEqual(ids.slice(0,3));expect(legacy.pinned_note_summaries).toHaveLength(3);expect((await api(request,"GET","teams",undefined,owner)).find((row:any)=>row.id===team.id).pinned_note_ids).toHaveLength(3);
  await api(request,"PATCH",`teams/${team.id}`,{description:"更新团队说明"},owner);expect((await api(request,"GET",`teams/${team.id}`,undefined,owner)).pinned_note_ids).toHaveLength(3);for(const note of notes)await api(request,"GET",`documents/${note.id}`,undefined,owner);
});
test("置顶选择使用模糊搜索、只展示匹配项，可移除重选，达到三篇后不能再添加；主题一致",async({page,request})=>{
  const {owner,team,notes}=await fixture(request);await login(page,owner);await page.goto(`/?team=${team.id}&view=settings`);const picker=page.locator(".team-pin-picker"),search=picker.getByLabel("搜索并添加笔记",{exact:true}),selected=picker.getByRole("list",{name:"已选置顶笔记",exact:true});await expect(search).toBeVisible();await expect(picker.getByRole("checkbox")).toHaveCount(0);await expect(picker.getByRole("option")).toHaveCount(0);
  for(const [query,note] of [["教程",notes[0]],["研究 规范",notes[2]],["实验",notes[1]]] as const){await search.fill(query);await expect(picker.getByRole("option")).toHaveCount(1);await picker.getByRole("option",{name:new RegExp(note.title)}).click();await expect(search).toHaveValue("");}
  await expect(selected.getByRole("listitem")).toHaveCount(3);await search.fill("会议");const fourth=picker.getByRole("option",{name:new RegExp(notes[3].title)});await expect(fourth).toBeDisabled();await selected.getByRole("button",{name:"移除置顶 "+notes[0].title,exact:true}).click();await expect(fourth).toBeEnabled();await fourth.click();await page.getByRole("button",{name:"保存团队设置",exact:true}).click();await expect(page.getByRole("status")).toHaveText("团队设置已保存");expect((await api(request,"GET",`teams/${team.id}`,undefined,owner)).pinned_note_ids).toEqual([notes[2].id,notes[1].id,notes[3].id]);
  for(const theme of ["light","dark"] as const){await chooseTheme(page,theme);await expect(page.locator("html")).not.toHaveClass(/theme-changing/);await picker.screenshot({path:`artifacts/web/team-pin-picker-${theme}.png`});}
  await page.locator(".team-hub>.management-tabs").getByRole("button",{name:"首页",exact:true}).click();await expect(page.locator(".team-pinned>button")).toHaveCount(3);await expect(page.locator(".team-pinned>button strong>span")).toHaveText([notes[2].title,notes[1].title,notes[3].title]);
});

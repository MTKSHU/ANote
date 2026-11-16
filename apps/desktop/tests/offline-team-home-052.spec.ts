import {test,expect,_electron,type ElectronApplication,type APIRequestContext} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api,switchWorkspace} from "../../web/tests/helpers";
import {person} from "../../web/tests/mcp-helpers";

let app:ElectronApplication|undefined;
const artifactRoot=process.env.ANOTE_TEST_ARTIFACT_ROOT||"artifacts/preview-052/desktop";
test.afterEach(async()=>{await app?.close().catch(()=>{});app=undefined;});
async function note(request:APIRequestContext,owner:any,library:any,title:string,body:string){
  const record=await api(request,"POST","documents",{space_id:library.id,title},owner),document=prosemirrorJSONToYDoc(schema,{type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text:body}]}]},"default");
  try{await api(request,"POST",`documents/${record.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64")},owner);}finally{document.destroy();}
  return record;
}

test("真实桌面离线团队首页使用已授权团队缓存，置顶与最近更新可读且不请求团队详情",async({request})=>{
  const origin=process.env.BASE_URL||"http://anote.internal:3000",owner=await person(request),suffix=randomUUID().slice(0,8);
  expect(origin).toBe("http://anote.internal:3000");
  const team=await api(request,"POST","teams",{name:"离线团队 "+suffix},owner),other=await api(request,"POST","teams",{name:"其他团队 "+suffix},owner);
  const library=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"团队离线知识库"},owner),foreign=await api(request,"POST","spaces",{kind:"team",team_id:other.id,name:"其他团队知识库"},owner),personal=await api(request,"POST","spaces",{kind:"personal",name:"个人知识库"},owner);
  const body="本地副本中的团队公告正文 "+suffix,pinned=await note(request,owner,library,"离线团队公告 "+suffix,body),recent=await note(request,owner,library,"离线团队最近更新 "+suffix,"最近更新的本地正文"),foreignNote=await note(request,owner,foreign,"其他团队笔记 "+suffix,"不属于当前团队"),personalNote=await note(request,owner,personal,"个人笔记 "+suffix,"个人正文");
  await api(request,"PATCH",`teams/${team.id}`,{announcement_doc_id:pinned.id},owner);
  const executable=path.resolve(process.env.DESKTOP_EXECUTABLE||"artifacts/preview-052/desktop/releases/ANote-linux-x64/ANote"),directory=path.resolve(artifactRoot,"offline-team-home-profiles",randomUUID()),asar=path.join(path.dirname(executable),"resources/app.asar"),asarSha256=createHash("sha256").update(await fs.readFile(asar)).digest("hex");
  if(process.env.ANOTE_EXPECTED_ASAR_SHA256)expect(asarSha256).toBe(process.env.ANOTE_EXPECTED_ASAR_SHA256);
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,"settings.json"),JSON.stringify({serverURL:origin}));
  app=await _electron.launch({executablePath:executable,args:["--no-sandbox","--password-store=basic"],env:{...process.env,ANOTE_CLIENT_DATA_DIR:directory,ANOTE_DESKTOP_TEST:"1"},timeout:45000});
  const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}));expect(runtime.packaged).toBe(true);expect(runtime.version).toBe(process.env.ANOTE_TEST_DESKTOP_VERSION||"0.5.2");
  const page=await app.firstWindow();await expect.poll(()=>page.evaluate(()=>!!window.anote)).toBe(true);await page.evaluate(input=>window.anote.connect(input),{serverURL:origin,username:owner.username,password:owner.password});
  await expect(page.locator(".academic-workspace")).toBeVisible();await switchWorkspace(page,team.name);
  const home=page.getByRole("region",{name:"团队首页内容",exact:true});await expect(home.locator(".pinned-note-card strong>span")).toHaveText([pinned.title]);await expect(home.getByRole("button",{name:"管理置顶",exact:true})).toBeVisible();
  await page.evaluate(()=>window.anote.configureOffline!({enabled:true,scope:"all-readable",includeAssets:true,backupIntervalMinutes:0}));
  await expect.poll(()=>page.evaluate(()=>window.anote.offlineStatus!().then(value=>value.complete&&!value.running&&value.availableDocuments>=4)),{timeout:60000}).toBe(true);
  await page.evaluate(()=>window.anote.offline(true));await expect.poll(()=>page.evaluate(()=>window.anote.state().then(value=>value.offline))).toBe(true);
  const detailRequests:string[]=[];page.on("request",request=>{if(/^\/api\/teams\/[^/]+$/.test(new URL(request.url()).pathname))detailRequests.push(request.url());});
  await page.goto("anote://app/?scope="+team.id);
  const cachedTeams=await page.evaluate(async()=>{const response=await fetch("/api/teams");return {status:response.status,cache:response.headers.get("X-ANote-Cache"),teams:await response.json()};});expect(cachedTeams.status).toBe(200);expect(cachedTeams.cache).toBe("offline-replica");expect(cachedTeams.teams.some((value:any)=>value.id===team.id&&value.announcement_doc_id===pinned.id)).toBe(true);
  await expect(home.locator(".pinned-note-card strong>span")).toHaveText([pinned.title]);await expect(home.locator(".pinned-note-announcement")).toHaveText("团队公告");await expect(home.locator(".team-recent>button")).toHaveCount(2);await expect(home.locator(".team-recent")).toContainText(recent.title);await expect(home).not.toContainText(foreignNote.title);await expect(home).not.toContainText(personalNote.title);await expect(home.getByRole("button",{name:"管理置顶",exact:true})).toHaveCount(0);
  expect(detailRequests).toEqual([]);await page.screenshot({path:path.join(artifactRoot,"offline-team-home.png"),animations:"disabled"});
  await home.locator(".pinned-note-card").click();await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(pinned.title);await expect(page.getByTestId("editor")).toContainText(body);expect(detailRequests).toEqual([]);expect((await page.evaluate(()=>window.anote.state())).offline).toBe(true);
  await fs.writeFile(path.join(artifactRoot,"offline-team-home-native-evidence.json"),JSON.stringify({recordedAt:new Date().toISOString(),runtime,asarSha256,offlineTeamHome:true,teamDetailRequests:detailRequests,visiblePinnedNotes:1,visibleRecentNotes:2,managementHidden:true,cachedPinnedBodyReadable:true},null,2)+"\n");
});

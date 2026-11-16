import {test,expect,type APIRequestContext} from "@playwright/test";
import {randomUUID,createHash} from "node:crypto";
import * as Y from "yjs";
import {initProseMirrorDoc,updateYFragment} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api} from "./helpers";
import {person} from "./mcp-helpers";

test.beforeEach(async({request})=>{
  expect(process.env.BASE_URL,"Offline API tests require an isolated local service").toBe("http://anote.internal:3000");
  expect((await request.get("/api/platform/public").then(r=>r.json())).public_origin).toBe("http://anote.internal:3000");
});
const state=(value:any)=>{const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(value.ystate,"base64"));return doc;};
const encode=(doc:Y.Doc)=>Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
function seeded(value:any,label:string){const doc=state(value);try{const fragment=doc.getXmlFragment("default"),{meta}=initProseMirrorDoc(fragment,schema);updateYFragment(doc,fragment,schema.nodeFromJSON({type:"doc",content:[{type:"paragraph",attrs:{blockId:"offline-paragraph"},content:[{type:"text",text:label}]}]}),meta);return encode(doc);}finally{doc.destroy();}}
function append(value:any,label:string){const doc=state(value);try{const paragraph=doc.getXmlFragment("default").get(0) as Y.XmlElement,text=paragraph.get(0) as Y.XmlText;text.insert(text.length,label);return encode(doc);}finally{doc.destroy();}}
const payload=(ystate:string,extra:any={})=>({schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate,...extra});
async function fixture(request:APIRequestContext){const owner=await person(request),library=await api(request,"POST","spaces",{kind:"personal",name:"离线完整结构验收"},owner),note=await api(request,"POST","documents",{space_id:library.id,title:"离线笔记"},owner),endpoint=`documents/${note.id}`;return {owner,library,note,endpoint};}

test("离线Yjs与服务器并发更新合并；opId幂等、无操作重试和标题保存不刷历史",async({request})=>{
  const {owner,endpoint}=await fixture(request),initial=await api(request,"GET",endpoint+"/offline",undefined,owner);
  await api(request,"POST",endpoint+"/offline-sync",payload(seeded(initial,"共同基线")),owner);
  const base=await api(request,"GET",endpoint+"/offline",undefined,owner),a=payload(append(base," · 离线本地")),b=payload(append(base," · 在线远端"));
  await Promise.all([api(request,"POST",endpoint+"/offline-sync",a,owner),api(request,"POST",endpoint+"/offline-sync",b,owner)]);
  const merged=await api(request,"GET",endpoint+"/offline",undefined,owner),content=JSON.stringify(merged.snapshot);expect(content).toContain("离线本地");expect(content).toContain("在线远端");
  const versions=await api(request,"GET",endpoint+"/versions",undefined,owner);await api(request,"POST",endpoint+"/offline-sync",a,owner);
  expect((await api(request,"GET",endpoint+"/versions",undefined,owner)).length).toBe(versions.length);
  await api(request,"POST",endpoint+"/offline-sync",payload(merged.ystate),owner);
  expect((await api(request,"GET",endpoint+"/versions",undefined,owner)).length).toBe(versions.length);
  await api(request,"POST",endpoint+"/offline-sync",payload(merged.ystate,{title:"离线标题",baseTitle:merged.title}),owner);
  expect((await api(request,"GET",endpoint+"/versions",undefined,owner)).length).toBe(versions.length);
  expect((await api(request,"GET",endpoint,undefined,owner)).title).toBe("离线标题");
  await api(request,"POST",endpoint+"/offline-sync",{...a,title:"不同的重试请求",baseTitle:"离线标题"},owner,409);
});

test("标题冲突和权限撤销拒绝整个离线提交，保留服务器最新稿",async({request})=>{
  const {owner,note,endpoint}=await fixture(request),editor=await person(request),sharing=await api(request,"GET",endpoint+"/sharing",undefined,owner);
  await api(request,"PATCH",endpoint+"/sharing",{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:editor.user.id,role:"editor"}]},owner);
  const base=await api(request,"GET",endpoint+"/offline",undefined,editor),local=payload(seeded(base,"尚未同步的离线正文"),{title:"本地标题",baseTitle:base.title});
  await api(request,"PATCH",endpoint,{title:"服务器标题"},owner);
  const versionsBefore=await api(request,"GET",endpoint+"/versions",undefined,owner);
  await api(request,"POST",endpoint+"/offline-sync",local,editor,409);
  expect((await api(request,"GET",endpoint+"/versions",undefined,owner)).length).toBe(versionsBefore.length);
  const untouched=await api(request,"GET",endpoint+"/offline",undefined,owner);expect(untouched.title).toBe("服务器标题");expect(JSON.stringify(untouched.snapshot)).not.toContain("尚未同步");
  const latest=await api(request,"GET",endpoint+"/sharing",undefined,owner);
  await api(request,"PATCH",endpoint+"/sharing",{visibility:"private",access_revision:latest.access_revision,collaborators:[{user_id:editor.user.id,role:"viewer"}]},owner);
  await api(request,"POST",endpoint+"/offline-sync",{...local,opId:randomUUID(),baseTitle:"服务器标题"},editor,403);
  expect((await api(request,"GET",endpoint+"/versions",undefined,owner)).length).toBe(versionsBefore.length);
  expect((await api(request,"GET",endpoint,undefined,owner)).id).toBe(note.id);
});

test("断网新建UUID保持稳定且重复上传只有一篇笔记",async({request})=>{
  const {owner,library,endpoint}=await fixture(request),base=await api(request,"GET",endpoint+"/offline",undefined,owner),id=randomUUID(),body=payload(seeded(base,"断网新建的完整富文本"),{title:"断网新笔记",create:{space_id:library.id,title:"断网新笔记",visibility:"private"}});
  const first=await api(request,"POST",`documents/${id}/offline-sync`,body,owner),second=await api(request,"POST",`documents/${id}/offline-sync`,body,owner);
  expect(first.id).toBe(id);expect(second.id).toBe(id);expect((await api(request,"GET","documents",undefined,owner)).filter((n:any)=>n.id===id)).toHaveLength(1);
  expect((await api(request,"GET",`documents/${id}/versions`,undefined,owner))).toHaveLength(1);
});

test("离线资源引用重新验证知识库范围和原笔记权限，拒绝跨范围注入且不留历史",async({request})=>{
  const {owner,library,endpoint}=await fixture(request),editor=await person(request),foreign=await api(request,"POST","spaces",{kind:"personal",name:"不可跨库的附件"},owner),hidden=await api(request,"POST","documents",{space_id:library.id,title:"未共享的附件笔记"},owner);
  async function upload(space:string,doc?:string){const bytes=Buffer.from("offline attachment scope verification"),hash=createHash("sha256").update(bytes).digest("hex"),started=await api(request,"POST","uploads",{space_id:space,doc_id:doc,filename:"scope.txt",bytes:bytes.length,hash},owner);const chunk=await request.put(`/api/uploads/${started.id}/chunk`,{headers:{Authorization:"Bearer "+owner.token,"Content-Type":"application/octet-stream","Upload-Offset":"0","X-Chunk-Sha256":hash},data:bytes});expect(chunk.ok(),await chunk.text()).toBeTruthy();return api(request,"POST",`uploads/${started.id}/complete`,{},owner);}
  const externalAsset=await upload(foreign.id),privateAsset=await upload(library.id,hidden.id),base=await api(request,"GET",endpoint+"/offline",undefined,owner),versions=await api(request,"GET",endpoint+"/versions",undefined,owner);
  function referencing(asset:any){const doc=state(base);try{const fragment=doc.getXmlFragment("default"),pm=initProseMirrorDoc(fragment,schema);updateYFragment(doc,fragment,schema.nodeFromJSON({type:"doc",content:[{type:"paragraph",attrs:{blockId:"body"}},{type:"mediaResource",attrs:{blockId:"attachment",assetId:asset.id,src:`/api/assets/${asset.id}/file`,localPath:`assets/${asset.id}.txt`,title:"scope.txt",kind:"file",mime:asset.mime,bytes:asset.bytes,hash:asset.hash,projection:"flat"}}]}),pm.meta);return encode(doc);}finally{doc.destroy();}}
  await api(request,"POST",endpoint+"/offline-sync",payload(referencing(externalAsset)),owner,409);
  const sharing=await api(request,"GET",endpoint+"/sharing",undefined,owner);await api(request,"PATCH",endpoint+"/sharing",{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:editor.user.id,role:"editor"}]},owner);
  await api(request,"POST",endpoint+"/offline-sync",payload(referencing(privateAsset)),editor,403);
  expect((await api(request,"GET",endpoint+"/versions",undefined,owner)).length).toBe(versions.length);expect(JSON.stringify((await api(request,"GET",endpoint,undefined,owner)).snapshot)).not.toContain("scope.txt");
});

test("离线同步独立支持超过8MiB的有效Ystate，超过32MiB请求体返回413",async({request})=>{
  const {owner,endpoint}=await fixture(request),base=await api(request,"GET",endpoint+"/offline",undefined,owner),doc=state(base);
  let expanded:string;
  try{doc.getMap("offline-state-size-fixture").set("history","x".repeat(7*1024*1024));expanded=encode(doc);}finally{doc.destroy();}
  expect(expanded.length).toBeGreaterThan(8*1024*1024);expect(expanded.length).toBeLessThan(24*1024*1024);
  const saved=await api(request,"POST",endpoint+"/offline-sync",payload(expanded),owner);expect(saved.ystate.length).toBeGreaterThan(8*1024*1024);expect(saved.snapshot).toEqual(base.snapshot);
  const oversized=await request.post("/api/"+endpoint+"/offline-sync",{headers:{Authorization:"Bearer "+owner.token},data:payload("A".repeat(33*1024*1024))});expect(oversized.status()).toBe(413);
});

test("编辑器合法nested重复ID可离线往返，重复顶层ID仍拒绝且不写正文或历史",async({request})=>{
  const {owner,endpoint}=await fixture(request),base=await api(request,"GET",endpoint+"/offline",undefined,owner);
  function stateWith(content:any[]){const doc=state(base);try{const fragment=doc.getXmlFragment("default"),pm=initProseMirrorDoc(fragment,schema);updateYFragment(doc,fragment,schema.nodeFromJSON({type:"doc",content}),pm.meta);return encode(doc);}finally{doc.destroy();}}
  const quote={type:"blockquote",attrs:{blockId:"quote"},content:[{type:"paragraph",attrs:{blockId:"nested"},content:[{type:"text",text:"引用第一段",marks:[{type:"bold"}]}]},{type:"paragraph",attrs:{blockId:"nested"},content:[{type:"text",text:"引用第二段"}]}]};
  const saved=await api(request,"POST",endpoint+"/offline-sync",payload(stateWith([quote])),owner);
  expect(saved.snapshot.content[0].content.map((node:any)=>node.attrs.blockId)).toEqual(["nested","nested"]);expect(JSON.stringify(saved.snapshot)).toContain("引用第一段");expect(JSON.stringify(saved.snapshot)).toContain("引用第二段");
  const versions=await api(request,"GET",endpoint+"/versions",undefined,owner);
  await api(request,"POST",endpoint+"/offline-sync",payload(stateWith([{type:"paragraph",attrs:{blockId:"duplicate"},content:[{type:"text",text:"非法顶层一"}]},{type:"paragraph",attrs:{blockId:"duplicate"},content:[{type:"text",text:"非法顶层二"}]}])),owner,400);
  expect((await api(request,"GET",endpoint+"/offline",undefined,owner)).snapshot).toEqual(saved.snapshot);expect((await api(request,"GET",endpoint+"/versions",undefined,owner)).length).toBe(versions.length);
});

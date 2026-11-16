import {test,expect,type APIRequestContext} from "@playwright/test";
import {randomUUID,createHash} from "node:crypto";
import fs from "node:fs/promises";
import * as Y from "yjs";
import {initProseMirrorDoc,updateYFragment} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api,admin} from "./helpers";
import {person} from "./mcp-helpers";

test.beforeEach(async({request})=>{
  expect(process.env.BASE_URL,"Inventory permission tests require the isolated Docker API").toBe("http://anote.internal:3000");
  expect((await request.get("/api/platform/public").then(response=>response.json())).public_origin).toBe("http://anote.internal:3000");
  expect((await request.get("/api/offline/inventory")).status()).toBe(401);
});
async function inventory(request:APIRequestContext,account:any){
  const result=await api(request,"GET","offline/inventory",undefined,account);
  expect(result.schema).toBe(EDITOR_SCHEMA_VERSION);expect(result.complete).toBe(true);expect(Number.isFinite(Date.parse(result.generatedAt))).toBe(true);
  for(const note of result.documents){expect(note.offline_revision).toMatch(/^[a-f0-9]{64}$/);expect(note).toHaveProperty("revision");expect(note).toHaveProperty("access_revision");expect(note).not.toHaveProperty("snapshot");expect(note).not.toHaveProperty("ystate");}
  return result;
}
async function share(request:APIRequestContext,owner:any,note:any,collaborators:any[],visibility="private"){
  const current=await api(request,"GET",`documents/${note.id}/sharing`,undefined,owner);
  await api(request,"PATCH",`documents/${note.id}/sharing`,{visibility,access_revision:current.access_revision,collaborators},owner);
}
async function privateFixture(request:APIRequestContext){
  const owner=await person(request),peer=await person(request),suffix=randomUUID().slice(0,8),library=await api(request,"POST","spaces",{kind:"personal",name:"PRIVATE-LIBRARY-"+suffix,description:"PRIVATE-DESCRIPTION-"+suffix},owner);
  const ancestor=await api(request,"POST",`spaces/${library.id}/folders`,{name:"PRIVATE-ANCESTOR-"+suffix},owner),folder=await api(request,"POST",`spaces/${library.id}/folders`,{name:"PRIVATE-FOLDER-"+suffix,parent_id:ancestor.id},owner);
  const note=await api(request,"POST","documents",{space_id:library.id,folder_id:folder.id,title:"Explicit shared "+suffix},owner),hidden=await api(request,"POST","documents",{space_id:library.id,title:"PRIVATE-NOTE-"+suffix},owner);
  return {owner,peer,library,ancestor,folder,note,hidden,suffix};
}

test("单篇指定分享仅返回flat导航壳，不泄露原库目录、描述、私有笔记或全库计数；撤权后完整消失",async({request})=>{
  const {owner,peer,library,ancestor,folder,note,hidden}=await privateFixture(request);
  await share(request,owner,note,[{user_id:peer.user.id,role:"editor"}]);
  expect((await api(request,"GET","spaces",undefined,peer)).some((row:any)=>row.id===library.id)).toBe(false);
  const result=await inventory(request,peer),book=result.libraries.find((row:any)=>row.id===library.id),entry=result.documents.find((row:any)=>row.id===note.id);
  expect(book).toEqual({id:library.id,name:"共享笔记",kind:"personal",team_id:null,role:"viewer",offline_scope:"documents",can_create:false});
  expect(entry).toMatchObject({id:note.id,role:"editor",folder_id:null,can_edit:true,can_manage:false});expect(result.folders[library.id]).toEqual([]);
  expect(result.catalogs[library.id].items).toEqual([{key:"note:"+note.id,kind:"note",id:note.id,parent_id:null}]);
  const serialized=JSON.stringify(result);for(const secret of [library.name,library.description,ancestor.name,ancestor.id,folder.name,folder.id,hidden.title,hidden.id])expect(serialized).not.toContain(secret);
  const platformAdmin=await admin(request),adminIndex=await inventory(request,platformAdmin);
  expect(adminIndex.libraries.some((row:any)=>row.id===library.id)).toBe(false);expect(adminIndex.documents.some((row:any)=>row.space_id===library.id)).toBe(false);
  await api(request,"GET",`documents/${note.id}/offline`,undefined,platformAdmin,403);
  await api(request,"GET",`spaces/${library.id}/folders`,undefined,peer,403);await api(request,"GET",`spaces/${library.id}/catalog`,undefined,peer,403);
  expect((await api(request,"GET",`documents/${note.id}/offline`,undefined,peer)).role).toBe("editor");
  await api(request,"POST","documents",{space_id:library.id,title:"must not create a sibling"},peer,403);
  await share(request,owner,note,[]);
  const revoked=await inventory(request,peer);expect(revoked.documents.some((row:any)=>row.id===note.id)).toBe(false);expect(revoked.libraries.some((row:any)=>row.id===library.id)).toBe(false);
  await api(request,"GET",`documents/${note.id}/offline`,undefined,peer,403);
});

test("个人整库只读分享包含授权目录和所有可读摘要，归档保留只读，撤销整库后不保留授权壳",async({request})=>{
  const {owner,peer,library,ancestor,folder,note,hidden}=await privateFixture(request);
  const archived=await api(request,"POST","documents",{space_id:library.id,folder_id:folder.id,title:"Archived readable"},owner);
  await api(request,"PATCH",`documents/${archived.id}`,{archived:true},owner);
  await api(request,"POST",`spaces/${library.id}/sharing/members`,{identity:peer.username},owner);
  const result=await inventory(request,peer),book=result.libraries.find((row:any)=>row.id===library.id);
  expect(book).toMatchObject({name:library.name,role:"viewer",offline_scope:"library",can_create:false,note_count:2,folder_count:2});
  expect(result.folders[library.id].map((row:any)=>row.id).sort()).toEqual([ancestor.id,folder.id].sort());
  for(const id of [note.id,hidden.id,archived.id])expect(result.documents.find((row:any)=>row.id===id)).toMatchObject({role:"viewer",can_edit:false,can_manage:false});
  expect(result.documents.find((row:any)=>row.id===archived.id).archived).toBe(true);expect(result.catalogs[library.id].items.some((row:any)=>row.id===archived.id)).toBe(false);
  const readable=await api(request,"GET",`documents/${note.id}/offline`,undefined,peer);expect(readable.role).toBe("viewer");
  await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:readable.ystate},peer,403);
  await api(request,"DELETE",`spaces/${library.id}/sharing/members/${peer.user.id}`,undefined,owner);
  const revoked=await inventory(request,peer);expect(revoked.documents.some((row:any)=>row.space_id===library.id)).toBe(false);expect(revoked.libraries.some((row:any)=>row.id===library.id)).toBe(false);
});

test("团队库viewer上限、默认contributor及平台管理员无跨团队捷径，均与documentRole/spaceRole一致",async({request})=>{
  const owner=await person(request),viewer=await person(request),contributor=await person(request),platformAdmin=await admin(request);
  const team=await api(request,"POST","teams",{name:"Offline permission boundary"},owner),library=await api(request,"POST","spaces",{kind:"team",team_id:team.id,access_mode:"team",name:"Team offline catalog"},owner);
  const note=await api(request,"POST","documents",{space_id:library.id,title:"Visible team note",visibility:"team"},owner),hidden=await api(request,"POST","documents",{space_id:library.id,title:"Hidden private team note",visibility:"private"},owner);
  await api(request,"POST",`spaces/${library.id}/members`,{user_id:viewer.user.id,role:"viewer"},owner);
  const invitation=await api(request,"POST",`teams/${team.id}/invites`,{},owner),token=new URL(invitation.path,"http://test").searchParams.get("invite");
  await api(request,"POST",`team-invitations/${token}/accept`,{},contributor);
  await share(request,owner,note,[{user_id:viewer.user.id,role:"editor"}],"team");
  const view=await inventory(request,viewer),viewerBook=view.libraries.find((row:any)=>row.id===library.id);expect(viewerBook).toMatchObject({role:"viewer",can_create:false});
  expect(view.documents.find((row:any)=>row.id===note.id)).toMatchObject({role:"viewer",can_edit:false});expect(view.documents.some((row:any)=>row.id===hidden.id)).toBe(false);
  expect(JSON.stringify(view)).not.toContain(hidden.title);expect(JSON.stringify(view.catalogs[library.id])).not.toContain(hidden.id);
  expect((await api(request,"GET",`documents/${note.id}/offline`,undefined,viewer)).role).toBe("viewer");
  const member=await inventory(request,contributor);expect(member.libraries.find((row:any)=>row.id===library.id)).toMatchObject({role:"contributor",can_create:true});
  expect(member.documents.find((row:any)=>row.id===note.id)).toMatchObject({role:"reviewer",can_edit:false});
  const authored=await api(request,"POST","documents",{space_id:library.id,title:"Own note as contributor"},contributor);
  expect((await inventory(request,contributor)).documents.find((row:any)=>row.id===authored.id)).toMatchObject({role:"admin",can_edit:true,can_manage:true});
  expect(platformAdmin.user.is_admin).toBe(true);const adminIndex=await inventory(request,platformAdmin);
  expect(adminIndex.libraries.some((row:any)=>row.id===library.id)).toBe(false);expect(adminIndex.documents.some((row:any)=>row.space_id===library.id)).toBe(false);
  await api(request,"GET",`documents/${note.id}/offline`,undefined,platformAdmin,403);
  await api(request,"POST",`teams/${team.id}/members`,{user_id:viewer.user.id,role:null},owner);
  const removed=await inventory(request,viewer);expect(removed.libraries.some((row:any)=>row.id===library.id)).toBe(false);expect(removed.documents.some((row:any)=>row.space_id===library.id)).toBe(false);
  await api(request,"GET",`documents/${note.id}/offline`,undefined,viewer,403);
});

async function upload(request:APIRequestContext,owner:any,library:any,doc?:any){
  const bytes=await fs.readFile("artifacts/server/fixtures/sample.png"),hash=createHash("sha256").update(bytes).digest("hex");
  const started=await api(request,"POST","uploads",{space_id:library.id,...(doc?{doc_id:doc.id}:{}),filename:"offline-preview.png",bytes:bytes.length,hash},owner);
  const chunk=await request.put(`/api/uploads/${started.id}/chunk`,{headers:{Authorization:"Bearer "+owner.token,"Content-Type":"application/octet-stream","Upload-Offset":"0","X-Chunk-Sha256":hash},data:bytes});expect(chunk.ok(),await chunk.text()).toBe(true);
  return api(request,"POST",`uploads/${started.id}/complete`,{},owner);
}
async function reference(request:APIRequestContext,owner:any,note:any,asset:any,attach=true){
  const attached=attach?(await api(request,"POST",`documents/${note.id}/assets`,{asset_ids:[asset.id]},owner))[0]:{...asset,localPath:`assets/${asset.id}.png`},initial=await api(request,"GET",`documents/${note.id}/offline`,undefined,owner),doc=new Y.Doc();
  try{
    Y.applyUpdate(doc,Buffer.from(initial.ystate,"base64"));const fragment=doc.getXmlFragment("default"),{meta}=initProseMirrorDoc(fragment,schema);
    updateYFragment(doc,fragment,schema.nodeFromJSON({type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()}},{type:"mediaResource",attrs:{blockId:randomUUID(),assetId:attached.id,src:attached.url,localPath:attached.localPath,title:attached.filename,kind:attached.kind,mime:attached.mime,bytes:attached.bytes,hash:attached.hash,projection:"flat"}}]}),meta);
    await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")},owner);
    return attached;
  }finally{doc.destroy();}
}

test("附件metadata完整且资产版本独立改变增量指纹；doc-only可读附件仍严格拒绝未授权用户",async({request})=>{
  const {owner,peer,library,note}=await privateFixture(request),stranger=await person(request),asset=await upload(request,owner,library,note);
  await reference(request,owner,note,asset);await share(request,owner,note,[{user_id:peer.user.id,role:"viewer"}]);
  const before=(await inventory(request,peer)).documents.find((row:any)=>row.id===note.id),download=await api(request,"GET",`documents/${note.id}/offline`,undefined,peer),saved=download.assets[0];
  expect(saved).toMatchObject({id:asset.id,kind:"image",filename:"offline-preview.png",mime:"image/png",hash:asset.hash,bytes:asset.bytes,url:`/api/assets/${asset.id}/file`,can_edit:false,jobs:[]});
  expect(saved).toHaveProperty("metadata");expect(saved).toHaveProperty("revision");expect(saved).toHaveProperty("path");expect(saved).not.toHaveProperty("storage_key");
  expect((await request.get(`/api/assets/${asset.id}/file`,{headers:{Authorization:"Bearer "+peer.token}})).status()).toBe(200);
  await api(request,"PATCH",`assets/${asset.id}`,{revision:Number(asset.revision),title:"Updated asset only"},owner);
  const after=(await inventory(request,peer)).documents.find((row:any)=>row.id===note.id);expect(after.revision).toBe(before.revision);expect(after.offline_revision).not.toBe(before.offline_revision);
  const refreshed=await api(request,"GET",`documents/${note.id}/offline`,undefined,peer);expect(refreshed.assets[0].title).toBe("Updated asset only");
  // An offline-created rich note can reuse an already readable asset without
  // calling the online attach endpoint. Its actual snapshot is authoritative.
  const copiedId=randomUUID(),copied=await api(request,"POST",`documents/${copiedId}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:refreshed.ystate,title:"Offline-created media copy",create:{space_id:library.id,title:"Offline-created media copy",visibility:"private"}},owner);
  expect(copied.assets[0].id).toBe(asset.id);
  const copiedBefore=(await inventory(request,owner)).documents.find((row:any)=>row.id===copiedId);
  await api(request,"PATCH",`assets/${asset.id}`,{revision:Number(refreshed.assets[0].revision),title:"Asset update after offline create"},owner);
  const copiedAfter=(await inventory(request,owner)).documents.find((row:any)=>row.id===copiedId);
  expect(copiedAfter.revision).toBe(copiedBefore.revision);expect(copiedAfter.offline_revision).not.toBe(copiedBefore.offline_revision);
  await api(request,"GET",`assets/${asset.id}`,undefined,stranger,403);await api(request,"GET",`documents/${note.id}/offline`,undefined,stranger,403);
});

test("legacy独立附件被指定共享文档引用后可读metadata且不可编辑，未共享用户和私有附件依旧拒绝",async({request})=>{
  const {owner,peer,library,note,hidden}=await privateFixture(request),stranger=await person(request),legacy=await upload(request,owner,library);
  expect(legacy.owner_doc_id).toBeNull();await reference(request,owner,note,legacy);await share(request,owner,note,[{user_id:peer.user.id,role:"viewer"}]);
  const view=await api(request,"GET",`assets/${legacy.id}`,undefined,peer);expect(view.id).toBe(legacy.id);expect(view.can_edit).toBe(false);
  const snapshot=await api(request,"GET",`documents/${note.id}/offline`,undefined,peer);expect(snapshot.assets[0].id).toBe(legacy.id);
  await api(request,"GET",`assets/${legacy.id}`,undefined,stranger,403);
  const hiddenAsset=await upload(request,owner,library,hidden);await reference(request,owner,hidden,hiddenAsset);
  await api(request,"GET",`assets/${hiddenAsset.id}`,undefined,peer,403);
  await reference(request,owner,note,hiddenAsset,false);
  await api(request,"GET",`documents/${note.id}/offline`,undefined,peer,403);
  const deniedBefore=(await inventory(request,peer)).documents.find((row:any)=>row.id===note.id);
  await api(request,"PATCH",`assets/${hiddenAsset.id}`,{revision:Number(hiddenAsset.revision),title:"Unreadable asset metadata must stay private"},owner);
  const deniedAfter=(await inventory(request,peer)).documents.find((row:any)=>row.id===note.id);
  expect(deniedAfter.offline_revision).toBe(deniedBefore.offline_revision);
  await share(request,owner,note,[]);await api(request,"GET",`assets/${legacy.id}`,undefined,peer,403);await api(request,"GET",`documents/${note.id}/offline`,undefined,peer,403);
});

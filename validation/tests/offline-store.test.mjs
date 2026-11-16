import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import * as Y from "yjs";
import {initProseMirrorDoc,prosemirrorJSONToYDoc,updateYFragment} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {OfflineStore} from "../../apps/desktop/main/offline-store.mjs";
import {BackupRepository} from "../../apps/desktop/main/incremental-backups.mjs";

const encoded=doc=>Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
const json=doc=>initProseMirrorDoc(doc.getXmlFragment("default"),schema).doc.toJSON();
const clone=state=>{const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(state,"base64"));return doc;};
const text=state=>{const doc=clone(state);try{return initProseMirrorDoc(doc.getXmlFragment("default"),schema).doc.textContent;}finally{doc.destroy();}};
function append(state,value){const doc=clone(state);try{const paragraph=doc.getXmlFragment("default").get(0),node=paragraph.get(0);node.insert(node.length,value);return encoded(doc);}finally{doc.destroy();}}
async function read(store,endpoint,headers){const url=new URL("anote://app/api/"+endpoint);return store.read(new Request(url,{headers}),url);}
async function backupData(store,version){return new BackupRepository(await store.backupRoot(),{identity:store.identity,schema:EDITOR_SCHEMA_VERSION}).read(version);}
async function rawBackup(store,version){return JSON.parse(await fs.readFile(path.join(await store.backupRoot(),version,"manifest.json"),"utf8"));}
// Body history is disk-backed after a worker commit. Read the durable record
// for state assertions, independent of OfflineStore's compact in-memory view.
async function durableRecord(store,key="note"){return JSON.parse(await fs.readFile(path.join(store.root,"documents",key+".json"),"utf8"));}
async function durableData(store){const data=structuredClone(store.data);for(const [key,record] of Object.entries(data.documents)){const saved=await durableRecord(store,key);record.ystate=saved.ystate;if(record.inflight&&!record.inflight.ystate)record.inflight={...record.inflight,ystate:saved.inflight?.ystate};}return data;}
// Filesystem fault injection must execute in the real worker's process-local
// module, rather than mocking fs only in this test runner's thread.
async function workerSetup(store,setup,kind="backup"){
  const script=path.join(store.root,"test-"+kind+"-worker-"+randomUUID()+".mjs"),entry=new URL("../../apps/desktop/main/"+kind+"-worker.mjs",import.meta.url).href;
  await fs.writeFile(script,`import fs from 'node:fs/promises';import path from 'node:path';${setup}\nawait import(${JSON.stringify(entry)});`);
  const field=kind+"Worker",previous=store[field];store[field]=script;return()=>{store[field]=previous;};
}
async function fileAppears(file){const deadline=Date.now()+10000;while(!(await fs.stat(file).catch(()=>null))){if(Date.now()>deadline)throw new Error("worker did not reach the injected filesystem operation");await new Promise(resolve=>setTimeout(resolve,5));}}
async function legacyBackup(store){
  const root=await store.backupRoot(),version=(Date.now()-60000)+"-"+randomUUID(),directory=path.join(root,version),data=await durableData(store),files=[];await fs.mkdir(directory);
  for(const asset of new Map(Object.values(data.documents).flatMap(doc=>doc.assets||[]).filter(asset=>asset.available&&asset.file).map(asset=>[asset.file,asset])).values()){
    const target=path.join(directory,asset.file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(store.root,asset.file),target);files.push({path:asset.file,bytes:asset.bytes,hash:asset.hash});
  }
  await fs.writeFile(path.join(directory,"manifest.json"),JSON.stringify({format:"anote-offline-backup",version:1,identity:store.identity,schema:8,createdAt:new Date().toISOString(),data,files}));return {id:version,directory};
}
async function legacyIncrementalBackup(store){
  const root=await store.backupRoot(),version=(Date.now()-30000)+"-"+randomUUID(),directory=path.join(root,version),data=await durableData(store),files=[];
  const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item),digest=bytes=>createHash("sha256").update(bytes).digest("hex");
  await fs.mkdir(directory);await fs.mkdir(path.join(root,"objects"),{recursive:true});
  const put=async bytes=>{const reference={hash:digest(bytes),bytes:bytes.length};await fs.writeFile(path.join(root,"objects",reference.hash),bytes);return reference;};
  const records=data.documents;delete data.documents;for(const key of ["config","lastBackup","lastPullAttempt","lastCacheUpdate","lastDownload","pullError","cacheComplete"])delete data[key];
  const index=await put(Buffer.from(stable(data))),documents={};for(const [id,record] of Object.entries(records)){delete record.downloadedAt;documents[id]=await put(Buffer.from(stable(record)));}
  for(const asset of new Map(Object.values(records).flatMap(doc=>doc.assets||[]).filter(asset=>asset.available&&asset.file).map(asset=>[asset.file,asset])).values())files.push({path:asset.file,...await put(await fs.readFile(path.join(store.root,asset.file)))});
  const content={index,documents,files};await fs.writeFile(path.join(directory,"manifest.json"),JSON.stringify({format:"anote-incremental-backup",version:2,identity:store.identity,schema:8,createdAt:new Date().toISOString(),...content,fingerprint:digest(stable(content)),assets:files.length,addedBytes:0}));return {id:version,directory};
}
async function largeAttachment(server){const bytes=Buffer.alloc(512*1024,73);server.doc.assets[0].hash=createHash("sha256").update(bytes).digest("hex");server.doc.assets[0].bytes=bytes.length;server.assetFiles.set("video",bytes);return bytes;}

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"anote-offline-")),profile=path.join(directory,"profile"),backups=path.join(directory,"backups");await fs.mkdir(backups);
  const session={profileRoot:profile,settings:{serverURL:"https://notes.example.test",user:{id:"alice"},offline:false},token:"test-token"};
  const initial=prosemirrorJSONToYDoc(schema,{type:"doc",content:[{type:"paragraph",attrs:{blockId:"paragraph"},content:[{type:"text",text:"初稿"}]}]},"default");
  const bytes=Buffer.from("existing panorama video bytes"),asset={id:"video",kind:"video",title:"全景视频",filename:"panorama.mp4",metadata:{width:2048,height:1024},hash:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,mime:"video/mp4",url:"/api/assets/video/file",path:"assets/video.mp4"};
  const server={doc:{id:"note",space_id:"library",title:"离线笔记",role:"admin",archived:false,tags:[],snapshot:json(initial),ystate:encoded(initial),assets:[asset]},extraDocuments:[],libraries:[{id:"library",name:"实验库",kind:"personal",role:"admin",offline_scope:"library",can_create:true}],folders:{library:[{id:"folder",name:"记录",parent_id:null}]},catalogs:{library:{revision:1,items:[]}},inventoryComplete:true,removed:new Set(),calls:new Map(),assetFiles:new Map([["video",bytes]]),thumbnailFiles:new Map(),operations:new Map(),postBodies:[],commits:0,loseResponse:false,forbidden:false,validationStatus:0,hook:null};initial.destroy();
  const fetcher=async(input,options={})=>{
    const url=new URL(input),endpoint=url.pathname.replace(/^\/api\//,"");
    server.calls.set(endpoint,(server.calls.get(endpoint)||0)+1);
    if(options.signal?.aborted)throw new Error("aborted");
    if(endpoint==="health")return Response.json({ok:true});
    if(endpoint==="offline/inventory")return Response.json({schema:EDITOR_SCHEMA_VERSION,complete:server.inventoryComplete,generatedAt:new Date().toISOString(),libraries:server.libraries,documents:[server.doc,...server.extraDocuments].filter(d=>!server.removed.has(d.id)).map(d=>{const {ystate,snapshot,assets,...metadata}=d;return {...metadata,offline_revision:createHash("sha256").update(JSON.stringify(d)).digest("hex")};}),folders:server.folders,catalogs:server.catalogs,teams:[],platform:{site_name:"ANote"}});
    if(endpoint==="spaces")return Response.json(server.libraries);
    if(endpoint==="documents")return Response.json(url.searchParams.get("archived")==="true"?[]:[{...server.doc,ystate:undefined,snapshot:undefined,assets:undefined}]);
    if(endpoint==="teams")return Response.json([]);
    if(endpoint==="platform/public")return Response.json({site_name:"anote"});
    if(endpoint==="spaces/library/folders")return Response.json([{id:"folder",name:"记录",parent_id:null}]);
    if(endpoint==="spaces/library/catalog")return Response.json({revision:1,entries:[]});
    const resource=/^assets\/([-\w]+)\/(file|thumbnail)$/.exec(endpoint);if(resource){const content=(resource[2]==="file"?server.assetFiles:server.thumbnailFiles).get(resource[1]);return content?new Response(content):Response.json({error:"未生成"},{status:404});}
    if(endpoint.endsWith("/offline")){const key=endpoint.split("/")[1],doc=[server.doc,...server.extraDocuments].find(d=>d.id===key);return doc&&!server.removed.has(key)?Response.json(doc):Response.json({error:"无权读取"},{status:403});}
    if(endpoint.endsWith("/offline-sync")){
      const body=JSON.parse(options.body);server.postBodies.push(body);
      if(server.libraries.find(l=>l.id===server.doc.space_id)?.archived)return Response.json({error:"知识库已归档，只能阅读，请先恢复知识库后再修改"},{status:409});
      if(server.forbidden)return Response.json({error:"笔记编辑权限已变更"},{status:403});
      if(server.validationStatus)return Response.json({error:"内容块 ID 重复"},{status:server.validationStatus});
      if(server.hook)await server.hook(body);
      if(!server.operations.has(body.opId)){
        if(body.title!==undefined&&server.doc.title!==body.baseTitle&&server.doc.title!==body.title&&!body.create)return Response.json({error:"笔记标题已被其他人修改"},{status:409});
        const doc=clone(server.doc.ystate);try{Y.applyUpdate(doc,Buffer.from(body.ystate,"base64"));server.doc={...server.doc,ystate:encoded(doc),snapshot:json(doc),...(body.title?{title:body.title}:{})};}finally{doc.destroy();}
        server.operations.set(body.opId,true);server.commits++;
      }
      if(server.loseResponse){server.loseResponse=false;throw new Error("response lost after commit");}
      return Response.json(server.doc);
    }
    throw new Error("Unexpected API "+endpoint);
  };
  const store=await new OfflineStore(session,()=>{},{fetch:fetcher}).load();
  const opened=[store];t.after(async()=>{for(const current of opened)await current.close();await fs.rm(directory,{recursive:true,force:true});});
  await store.configure({libraryIds:["library"],includeAssets:true,backupDirectory:backups,backupIntervalMinutes:0});
  async function reopen(){await store.close();const next=await new OfflineStore(session,()=>{},{fetch:fetcher}).load();opened.push(next);return next;}
  return {directory,profile,backups,session,store,server,fetcher,reopen,asset,bytes};
}

test("整库副本包含冷启动所需8类数据、Ystate和可Range读取附件，重启后仍可用",async t=>{
  const {store,session,reopen,bytes}=await fixture(t);await store.download();assert.equal(store.status().pending,0);
  const next=await reopen();session.settings.offline=true;
  for(const endpoint of ["spaces","documents","documents?archived=true","teams","platform/public","trash/documents","trash/spaces","trash/teams"]){const response=await read(next,endpoint);assert.equal(response.status,200,endpoint);await response.json();}
  assert.equal((await (await read(next,"documents/note")).json()).title,"离线笔记");
  assert.equal((await (await read(next,"spaces/library/folders")).json())[0].id,"folder");
  const response=await read(next,"assets/video/file",{Range:"bytes=2-8"});assert.equal(response.status,206);assert.equal(response.headers.get("X-ANote-Cache"),"offline-replica");assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(2,9));
  const index=JSON.parse(await fs.readFile(path.join(next.root,"index.json"),"utf8"));assert.equal(index.format,2);assert.deepEqual(index.documents,["note"]);assert.equal(JSON.stringify(index).includes("ystate"),false);
});

test("断网正文和标题队列跨重启保留，与服务器并发Yjs修改合并，丢失响应按同opId重试",async t=>{
  const {store,server,reopen}=await fixture(t);await store.download();const base=server.doc.ystate;
  await store.cacheDocument({id:"note",ystate:append(base," · 本地")});await store.queueTitle("note","离线新标题");
  server.doc.ystate=append(base," · 远端");const remote=clone(server.doc.ystate);try{server.doc.snapshot=json(remote);}finally{remote.destroy();}server.loseResponse=true;
  const next=await reopen();assert.equal(next.status().pending,1);await next.sync();assert.equal(next.status().pending,1);const opId=server.postBodies[0].opId;
  await next.sync();assert.equal(server.postBodies[1].opId,opId);assert.equal(server.commits,1);assert.equal(next.status().pending,0);
  assert.match(text(server.doc.ystate),/本地/);assert.match(text(server.doc.ystate),/远端/);assert.equal(server.doc.title,"离线新标题");
  assert.equal(await next.cacheDocument({id:"note",ystate:server.doc.ystate}),false);assert.equal(next.status().pending,0);
});

test("同步期间继续编辑会保留新队列，确认旧请求不删除较新的正文",async t=>{
  const {store,server}=await fixture(t);await store.download();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," · 第一段")});
  let invoked=false;server.hook=async body=>{if(invoked)return;invoked=true;await store.cacheDocument({id:"note",ystate:append(body.ystate," · 请求期间新写")});};
  await store.sync();assert.equal(store.status().pending,1);assert.match(text((await durableRecord(store,"note")).ystate),/请求期间新写/);
  await store.sync();assert.equal(store.status().pending,0);assert.match(text(server.doc.ystate),/请求期间新写/);
});

test("权限撤销保存只读冲突副本，标题冲突可复验权限后选择本地标题继续同步",async t=>{
  const {store,server}=await fixture(t);await store.download();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," · 未同步稿")});server.forbidden=true;await store.sync();
  assert.equal(store.status().conflicts.length,1);assert.equal((await read(store,"documents/note")).status,403);assert.equal(store.status().conflicts[0].title,"访问权限已变化的本地修改");
  assert.ok((await fs.readdir(path.join(store.root,"conflicts"))).length);assert.match(text((await durableRecord(store,"note")).ystate),/未同步稿/);
  server.forbidden=false;await store.resolveConflict("note","local-title");await store.sync();await store.queueTitle("note","我的标题");server.doc.title="其他人标题";
  await store.sync();assert.equal(store.status().conflicts[0].remoteTitle,"其他人标题");await store.resolveConflict("note","local-title");await store.sync();assert.equal(server.doc.title,"我的标题");assert.equal(store.status().conflicts.length,0);
});

test("独立备份保留完整结构和附件；恢复创建新Y事务，保留当前稿且不被旧IndexedDB复活",async t=>{
  const {store,server,asset}=await fixture(t);
  const rich=clone(server.doc.ystate);try{const fragment=rich.getXmlFragment("default"),{meta}=initProseMirrorDoc(fragment,schema);updateYFragment(rich,fragment,schema.nodeFromJSON({type:"doc",content:[{type:"paragraph",attrs:{blockId:"paragraph"},content:[{type:"text",text:"初稿",marks:[{type:"bold"}]}]},{type:"mediaResource",attrs:{blockId:"panorama",assetId:asset.id,localPath:asset.path,src:asset.url,title:"360全景视频",kind:"video",mime:asset.mime,bytes:asset.bytes,hash:asset.hash,projection:"equirectangular"}}]}),meta);server.doc.ystate=encoded(rich);server.doc.snapshot=json(rich);}finally{rich.destroy();}
  await store.download();await store.configure({retention:1});
  const original=server.doc.ystate,first=await store.backup();await store.cacheDocument({id:"note",ystate:append(original," · 备份后新增")});await store.queueTitle("note","当前未同步标题");const beforeRestore=(await durableRecord(store,"note")).ystate;
  const restored=await store.restore(first.id);assert.ok(restored.preserved);assert.equal(store.data.documents.note.metadata.title,"离线笔记");assert.equal(text((await durableRecord(store,"note")).ystate),"初稿");
  assert.equal(store.data.documents.note.snapshot.content[1].attrs.projection,"equirectangular");assert.equal(store.data.documents.note.snapshot.content[0].content[0].marks[0].type,"bold");
  const stale=clone(beforeRestore);try{Y.applyUpdate(stale,Buffer.from((await durableRecord(store,"note")).ystate,"base64"));assert.equal(text(encoded(stale)),"初稿");}finally{stale.destroy();}
  const preserved=await backupData(store,restored.preserved);assert.match(text(preserved.data.documents.note.ystate),/备份后新增/);assert.equal(preserved.data.documents.note.metadata.title,"当前未同步标题");assert.equal(preserved.files.length,1);
  assert.equal(store.status().pending,1);const response=await read(store,"assets/video/file");assert.equal(response.status,200);
  await store.backup();assert.equal((await store.listBackups()).length,1);
});

test("损坏附件/跨账号备份/符号链接均拒绝恢复或备份，当前稿保持完整",async t=>{
  const {store,asset}=await fixture(t);await store.download();const version=await store.backup(),file=path.join(version.directory,"manifest.json"),manifest=JSON.parse(await fs.readFile(file,"utf8")),current=(await durableRecord(store,"note")).ystate;
  manifest.identity.userId="another-account";await fs.writeFile(file,JSON.stringify(manifest));await assert.rejects(()=>store.restore(version.id),/不匹配/);assert.equal((await durableRecord(store,"note")).ystate,current);
  manifest.identity.userId="alice";await fs.writeFile(file,JSON.stringify(manifest));await fs.writeFile(path.join(await store.backupRoot(),"objects",manifest.files[0].hash),"broken");await assert.rejects(()=>store.restore(version.id),/损坏/);assert.equal((await durableRecord(store,"note")).ystate,current);
  const target=path.join(store.root,`assets/${asset.id}-${asset.hash}`);await fs.unlink(target);await fs.symlink(file,target);await assert.rejects(()=>store.backup(),/符号链接/);
});

test("离线新建使用稳定UUID并持久排队；仅改一篇不重写其他笔记文件",async t=>{
  const {store}=await fixture(t);await store.download();const originalFile=path.join(store.root,"documents","note.json"),before=await fs.stat(originalFile),originalBytes=await fs.readFile(originalFile,"utf8");
  const created=await store.createDocument({space_id:"library",title:"断网新建"});assert.match(created.id,/^[a-f0-9-]{36}$/);assert.equal(created.offline_new,true);
  await store.queueTitle(created.id,"断网新建 · 标题修改");const after=await fs.stat(originalFile);assert.equal(after.mtimeNs??after.mtimeMs,before.mtimeNs??before.mtimeMs);assert.equal(await fs.readFile(originalFile,"utf8"),originalBytes);
});

test("普通笔记元数据刷新保留已下载附件；在线标题确认更新基线而不覆盖离线待传标题",async t=>{
  const {store,server}=await fixture(t);await store.download();assert.deepEqual(store.status().downloadedLibraryIds,["library"]);
  const ordinary={...server.doc,title:"在线已改标题"};delete ordinary.assets;
  await store.observe(new URL("anote://app/api/documents/note"),ordinary);
  assert.equal(store.status().assets,1);assert.equal((await read(store,"assets/video/file")).status,200);
  await store.cacheDocument({id:"note",ystate:server.doc.ystate,metadata:ordinary});assert.equal(store.status().pending,0);
  await store.queueTitle("note","本地待传标题");assert.equal(store.data.documents.note.pending.baseTitle,"在线已改标题");
  await store.cacheDocument({id:"note",ystate:server.doc.ystate,metadata:{...ordinary,title:"旧页面元数据标题"}});
  assert.equal(store.data.documents.note.metadata.title,"本地待传标题");assert.equal(store.data.documents.note.pending.baseTitle,"在线已改标题");assert.equal(store.data.documents.note.serverTitle,"在线已改标题");
});

test("已缓存笔记收到明确权限拒绝后只读保留，重新启动也不会恢复旧编辑权限",async t=>{
  const {store,reopen}=await fixture(t);await store.download();await store.denyDocument("note",403,"权限已撤销");
  assert.equal(store.status().conflicts[0].kind,"permission");assert.equal((await read(store,"documents/note")).status,403);
  const next=await reopen();assert.equal((await read(next,"documents/note")).status,403);assert.equal(next.status().documents,0);assert.equal(next.status().unavailable,1);assert.equal(next.status().pending,0);
});

test("关闭会中止并等待所有在途请求；换账号后旧引擎不能发出带新凭据的请求",async t=>{
  const {session,profile}=await fixture(t);let requests=0;
  const blocked=await new OfflineStore({...session,profileRoot:path.join(profile,"other")},()=>{},{fetch:(_url,{signal})=>new Promise((_resolve,reject)=>{requests++;signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});})}).load();
  const pending=blocked.download().catch(()=>{});await new Promise(resolve=>setImmediate(resolve));await blocked.close();await pending;assert.equal(blocked.active.size,0);assert.ok(requests>0);
  const newSession={...session,profileRoot:path.join(profile,"identity")};const guarded=await new OfflineStore(newSession,()=>{},{fetch:async()=>{throw new Error("should not fetch");}}).load();try{newSession.settings={...session.settings,user:{id:"bob"}};await assert.rejects(()=>guarded.api("spaces"),/账号或服务器已切换/);}finally{await guarded.close();}
});

async function settled(store){for(let attempt=0;attempt<1000;attempt++){if(!store.running&&!store.probing&&!store.active.size)return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("后台离线任务未完成");}
function addRemote(server,id="second",library="library"){
  const note=structuredClone(server.doc);note.id=id;note.space_id=library;note.title="后台新笔记 "+id;note.assets=[];note.ystate=append(note.ystate," · 后台新增");const doc=clone(note.ystate);try{note.snapshot=json(doc);}finally{doc.destroy();}server.extraDocuments.push(note);return note;
}

test("新用户默认关闭且包含附件，启用后自动拉取全部可读库，关闭仍推送已有修改",async t=>{
  const {store,server}=await fixture(t);assert.equal(store.status().enabled,false);assert.equal(store.status().config.scope,"all-readable");assert.equal(store.status().config.includeAssets,true);
  await store.maintenance();assert.equal(server.calls.get("offline/inventory")||0,0);
  server.libraries.push({id:"other",name:"另一个可读库",role:"editor",kind:"team",can_create:true});server.folders.other=[];server.catalogs.other={revision:1,items:[]};addRemote(server,"other-note","other");
  await store.configure({enabled:true});await settled(store);assert.equal(store.status().complete,true);assert.equal(store.status().availableDocuments,2);assert.equal(store.status().assets,1);assert.deepEqual(store.status().downloadedLibraryIds.sort(),["library","other"]);
  const calls=server.calls.get("offline/inventory");await store.configure({enabled:false});await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 关闭后待上传")});store.nextPullAt=0;await store.maintenance();assert.equal(server.calls.get("offline/inventory"),calls);assert.equal(store.status().pending,0);assert.match(text(server.doc.ystate),/关闭后待上传/);assert.equal(store.status().pullState,"disabled");
});

test("后台按指纹增量拉取新建与修改，附件hash未变时不重复下载，断网重启完整读取详情",async t=>{
  const {store,server,reopen,session,bytes}=await fixture(t);await store.configure({enabled:true});await settled(store);
  const originalRequests=server.calls.get("assets/video/file"),noteRequests=server.calls.get("documents/note/offline");store.nextPullAt=0;await store.maintenance();assert.equal(server.calls.get("documents/note/offline"),noteRequests);assert.equal(server.calls.get("assets/video/file"),originalRequests);
  const second=addRemote(server);server.doc.title="服务器改名";server.doc.ystate=append(server.doc.ystate," · 远端更新");store.nextPullAt=0;await store.maintenance();assert.equal(store.status().availableDocuments,2);assert.equal(store.data.documents.note.metadata.title,"服务器改名");assert.match(text((await durableRecord(store,"note")).ystate),/远端更新/);assert.equal(server.calls.get("assets/video/file"),originalRequests);assert.ok(store.data.documents[second.id]);
  const next=await reopen();session.settings.offline=true;const before=[...server.calls];await next.maintenance();assert.deepEqual([...server.calls],before);
  assert.equal((await (await read(next,"assets/video")).json()).kind,"video");assert.equal((await (await read(next,"assets/video")).json()).title,"全景视频");assert.deepEqual((await (await read(next,"assets/video")).json()).metadata,{width:2048,height:1024});
  const range=await read(next,"assets/video/file",{Range:"bytes=1-7"});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(1,8));assert.equal((await (await read(next,"documents")).json()).length,2);assert.equal((await read(next,"spaces/library/catalog")).status,200);
});

test("doc-only分享只缓存安全flat目录；普通GET和renderer元数据不能回填隐藏目录与库名",async t=>{
  const {store,server}=await fixture(t);server.libraries=[{id:"library",name:"共享笔记",kind:"personal",role:"viewer",offline_scope:"documents",can_create:false}];server.folders.library=[];server.catalogs.library={revision:1,items:[{kind:"note",id:"note",parent_id:null,title:server.doc.title}]};server.doc.folder_id="hidden-parent";server.doc.folder_name="不可见父目录";server.doc.space_name="不可见私有库名";
  await store.download();await store.observe("/api/documents/note",server.doc);await store.cacheDocument({id:"note",ystate:server.doc.ystate,metadata:server.doc});
  const note=await (await read(store,"documents/note")).json();assert.equal(note.folder_id,null);assert.equal(note.folder_name,null);assert.equal(note.space_name,"共享笔记");assert.deepEqual(await (await read(store,"spaces/library/folders")).json(),[]);assert.equal(server.calls.get("spaces/library/folders")||0,0);assert.equal(server.calls.get("spaces/library/catalog")||0,0);await assert.rejects(()=>store.createDocument({space_id:"library",title:"不能新建"}),/创建权限/);
});

test("撤销可读权限后导航、详情、资产及旧checkout均拒绝，dirty私有保留且备份恢复不复活",async t=>{
  const {store,server}=await fixture(t);await store.download();const before=await store.backup();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," · 尚未上传的私人修改")});await store.queueTitle("note","不得泄露的本地标题");
  server.removed.add("note");server.libraries=[];server.folders={};server.catalogs={};await store.download();assert.equal(store.status().unavailable,1);assert.equal(store.status().conflicts[0].title,"访问权限已变化的本地修改");assert.equal(JSON.stringify(store.status()).includes("不得泄露"),false);assert.equal(store.allowLegacyDocument("note"),false);assert.equal(store.allowLegacyDocument("never-cached"),false);
  for(const endpoint of ["documents/note","documents/note/info","assets/video","assets/video/file","assets/video/thumbnail","spaces/library/folders","spaces/library/catalog"]){const response=await read(store,endpoint);assert.equal(response.status,403,endpoint);}
  assert.deepEqual(await (await read(store,"documents")).json(),[]);assert.deepEqual(await (await read(store,"spaces")).json(),[]);
  const privateFile=store.data.documents.note.privateBackupFile,privateCopy=JSON.parse(await fs.readFile(path.join(store.root,privateFile),"utf8"));assert.match(text(privateCopy.document.ystate),/私人修改/);assert.equal(privateCopy.document.metadata.title,"不得泄露的本地标题");
  await store.observe("/api/spaces",[{id:"library",name:"晚返回的私有库"}]);await store.observe("/api/documents/note",server.doc);assert.equal(store.isUnavailable("note"),true);assert.deepEqual(await (await read(store,"spaces")).json(),[]);await store.restore(before.id);assert.equal((await read(store,"documents/note")).status,403);assert.deepEqual(await (await read(store,"spaces")).json(),[]);
});

test("共享资产仍有可读笔记引用可继续离线访问；缩略图独立缓存且缺失图片可用原件",async t=>{
  const {store,server,asset,bytes}=await fixture(t);const thumbnail=Buffer.from("test jpeg thumbnail"),descriptor={url:"/api/assets/video/thumbnail",mime:"image/jpeg",bytes:thumbnail.length,hash:createHash("sha256").update(thumbnail).digest("hex")};server.doc.assets[0].thumbnail=descriptor;server.thumbnailFiles.set("video",thumbnail);
  const second=addRemote(server);second.assets=[structuredClone(server.doc.assets[0])];await store.download();assert.deepEqual(Buffer.from(await (await read(store,"assets/video/thumbnail")).arrayBuffer()),thumbnail);
  server.removed.add("note");await store.download();assert.equal((await read(store,"documents/note")).status,403);assert.equal((await read(store,"assets/video")).status,200);assert.deepEqual(Buffer.from(await (await read(store,"assets/video/file")).arrayBuffer()),bytes);
  delete second.assets[0].thumbnail;second.assets[0].kind="image";second.assets[0].mime="image/png";await store.download();assert.deepEqual(Buffer.from(await (await read(store,"assets/video/thumbnail")).arrayBuffer()),bytes);
  server.removed.add(second.id);await store.download();assert.equal((await read(store,"assets/video")).status,403);assert.equal(store.isAssetUnavailable(asset.id),true);
});

test("不完整inventory不触发撤权；失败保留已下载文件并在重试时只补缺失内容",async t=>{
  const {store,server}=await fixture(t);await store.download();const count=server.calls.get("assets/video/file");server.inventoryComplete=false;server.removed.add("note");await assert.rejects(()=>store.download(),/未完整返回/);assert.equal((await read(store,"documents/note")).status,200);
  server.inventoryComplete=true;server.removed.clear();const extra=addRemote(server);extra.assets=[{id:"missing",kind:"video",mime:"video/mp4",title:"稍后下载",bytes:4,hash:createHash("sha256").update("late").digest("hex"),url:"/api/assets/missing/file"}];await assert.rejects(()=>store.download(),/未生成/);assert.equal(store.status().complete,false);assert.equal(store.status().assetsMissing,1);assert.equal(server.calls.get("assets/video/file"),count);
  const extraFetch=server.calls.get("documents/second/offline");server.assetFiles.set("missing",Buffer.from("late"));await store.download();assert.equal(store.status().complete,true);assert.equal(server.calls.get("documents/second/offline"),extraFetch);assert.equal(server.calls.get("assets/video/file"),count);
});

test("丢失ACK后继续编辑并后台pull，仍重试原wire payload再提交新稿",async t=>{
  const {store,server}=await fixture(t);await store.download();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," · 首稿")});await store.queueTitle("note","首个本地标题");server.loseResponse=true;await store.sync();const first=structuredClone(server.postBodies[0]);
  await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · ACK期间续写")});await store.queueTitle("note","最终标题");server.doc.ystate=append(server.doc.ystate," · 服务器另一编辑");await store.download();await store.sync();assert.deepEqual(server.postBodies[1],first);assert.equal(store.status().pending,1);await store.sync();assert.equal(store.status().pending,0);assert.equal(server.doc.title,"最终标题");assert.match(text(server.doc.ystate),/首稿/);assert.match(text(server.doc.ystate),/ACK期间续写/);assert.match(text(server.doc.ystate),/服务器另一编辑/);
});

test("旧配置迁移：未配置用户首次启用默认含附件；已选择库用户保留显式禁用附件",async t=>{
  const {store,reopen}=await fixture(t);await store.close();const file=path.join(store.root,"index.json"),saved=JSON.parse(await fs.readFile(file,"utf8"));delete saved.config.enabled;delete saved.config.scope;saved.config.libraryIds=[];saved.config.includeAssets=false;await fs.writeFile(file,JSON.stringify(saved));
  const unconfigured=await reopen();assert.equal(unconfigured.status().config.enabled,false);assert.equal(unconfigured.status().config.scope,"all-readable");assert.equal(unconfigured.status().config.includeAssets,true);await unconfigured.close();saved.config.libraryIds=["library"];await fs.writeFile(file,JSON.stringify(saved));const configured=await reopen();assert.equal(configured.status().config.enabled,true);assert.equal(configured.status().config.scope,"selected");assert.equal(configured.status().config.includeAssets,false);
});

test("本地原件被移除时完整性转为缺失并只补该文件；资产metadata变更复用已验证原件",async t=>{
  const {store,server,bytes}=await fixture(t);await store.download();const requests=server.calls.get("assets/video/file");server.doc.assets[0].title="服务器更新后的附件标题";server.doc.assets[0].revision=2;await store.download();assert.equal((await (await read(store,"assets/video")).json()).title,"服务器更新后的附件标题");assert.equal(server.calls.get("assets/video/file"),requests);
  await fs.unlink(path.join(store.root,store.data.documents.note.assets[0].file));server.assetFiles.delete("video");await assert.rejects(()=>store.download(),/未生成/);assert.equal(store.status().assetsMissing,1);assert.equal(store.status().complete,false);server.assetFiles.set("video",bytes);await store.download();assert.equal(store.status().assetsMissing,0);assert.equal(store.status().complete,true);
});

test("关闭常驻离线会中止在途自动拉取，既有副本保持可读",async t=>{
  const {store}=await fixture(t);await store.download();const original=store.fetcher;let entered;const started=new Promise(resolve=>{entered=resolve;});store.fetcher=(url,options)=>url.endsWith("/api/offline/inventory")?new Promise((_resolve,reject)=>{entered();options.signal.addEventListener("abort",()=>reject(new Error("自动拉取已中止")),{once:true});}):original(url,options);
  await store.configure({enabled:true});await started;await store.configure({enabled:false});await settled(store);assert.equal(store.status().pullState,"disabled");assert.equal(store.status().running,false);assert.equal((await read(store,"documents/note")).status,200);assert.equal((await read(store,"assets/video/file")).status,200);
});

test("在线新建且晚于上一份inventory的已认证笔记不会误判撤权，下一份清单仍会复核",async t=>{
  const {store,server}=await fixture(t);await store.download();const fresh=addRemote(server,"created-after-inventory");await store.cacheDocument({id:fresh.id,ystate:fresh.ystate,metadata:fresh});assert.equal(store.isUnavailable(fresh.id),false);assert.equal((await read(store,"documents/"+fresh.id)).status,200);await store.download();assert.equal(store.isUnavailable(fresh.id),false);
  server.removed.add(fresh.id);await store.download();assert.equal(store.isUnavailable(fresh.id),true);const late=append(fresh.ystate," · 撤权时最后一次本地落盘");await store.cacheDocument({id:fresh.id,ystate:late,metadata:fresh});assert.equal((await read(store,"documents/"+fresh.id)).status,403);const privateCopy=JSON.parse(await fs.readFile(path.join(store.root,store.data.documents[fresh.id].privateBackupFile),"utf8"));assert.match(text(privateCopy.document.ystate),/最后一次本地落盘/);
});

test("本地副本关闭时初次读取和远端Ystate仅落缓存，真正本地编辑才加入上传队列",async t=>{
  const {store,server}=await fixture(t);assert.equal(store.status().enabled,false);
  await store.cacheDocument({id:"note",ystate:server.doc.ystate,metadata:server.doc,local:false});await store.maintenance();assert.equal(store.status().pending,0);assert.equal(server.postBodies.length,0);
  const remote=append(server.doc.ystate," · 远端通知");await store.cacheDocument({id:"note",ystate:remote,metadata:server.doc,local:false});await store.maintenance();assert.equal(store.status().pending,0);assert.equal(server.postBodies.length,0);
  await store.cacheDocument({id:"note",ystate:append(remote," · 用户真实编辑"),metadata:server.doc,local:true});assert.equal(store.status().pending,1);await store.maintenance();assert.equal(store.status().pending,0);assert.match(text(server.doc.ystate),/用户真实编辑/);
});

test("永久400验证失败保留原稿且暂停自动重试，重启不刷错误，手动与新修改各可重试",async t=>{
  const {store,server,reopen}=await fixture(t);await store.download();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," · 需要保留的本地稿"),local:true});server.validationStatus=400;await store.sync();
  const rejected=structuredClone(server.postBodies[0]);assert.equal(store.status().conflicts[0].kind,"validation");assert.equal(store.data.documents.note.metadata.role,"admin");assert.equal(store.status().lastError,"内容块 ID 重复");
  await store.maintenance();await store.maintenance();assert.equal(server.postBodies.length,1);assert.equal(store.status().lastError,"内容块 ID 重复");
  const next=await reopen();await next.maintenance();assert.equal(server.postBodies.length,1);assert.equal(next.status().lastError,"内容块 ID 重复");
  await next.sync();assert.equal(server.postBodies.length,2);assert.notEqual(server.postBodies[1].opId,rejected.opId);assert.equal(next.status().conflicts[0].kind,"validation");
  server.validationStatus=0;await next.cacheDocument({id:"note",ystate:append((await durableRecord(next,"note")).ystate," · 用户修正文稿"),metadata:server.doc,local:true});await next.maintenance();assert.equal(next.status().conflicts.length,0);assert.equal(next.status().pending,0);assert.match(text(server.doc.ystate),/需要保留的本地稿/);assert.match(text(server.doc.ystate),/用户修正文稿/);
  const copies=(await fs.readdir(path.join(next.root,"conflicts"))).filter(file=>file.startsWith("validation-"));assert.equal(copies.length,2);const preserved=(await Promise.all(copies.map(async file=>JSON.parse(await fs.readFile(path.join(next.root,"conflicts",file),"utf8"))))).find(copy=>copy.request.opId===rejected.opId);assert.ok(preserved);assert.match(text(preserved.document.ystate),/需要保留的本地稿/);
});

test("旧版重复ID失败队列升级后只自动重新验证一次，若仍失败再次重启也保持暂停",async t=>{
  const {store,server,reopen}=await fixture(t);await store.download();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," · 旧版未上传稿")});server.validationStatus=400;await store.sync();
  const legacy=store.data.documents.note;delete legacy.validationRecoveryVersion;delete legacy.validationPaused;legacy.blocked=false;await store.serial(()=>store.persist("note"));
  const next=await reopen();await next.maintenance();assert.equal(server.postBodies.length,2);assert.deepEqual(server.postBodies[1],server.postBodies[0]);assert.equal(next.data.documents.note.validationPaused,true);await next.close();
  const again=await reopen();await again.maintenance();assert.equal(server.postBodies.length,2);assert.equal(again.status().conflicts[0].kind,"validation");
});

test("旧版失败请求在服务端修复后升级重试成功，恢复备份也可重新验证并保留当前稿",async t=>{
  const {store,server,reopen}=await fixture(t);await store.download();const healthy=await store.backup();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," · 旧版待恢复的修改")});server.validationStatus=400;await store.sync();
  const legacy=store.data.documents.note;delete legacy.validationRecoveryVersion;delete legacy.validationPaused;legacy.blocked=false;await store.serial(()=>store.persist("note"));server.validationStatus=0;const next=await reopen();await next.maintenance();assert.equal(next.status().pending,0);assert.match(text(server.doc.ystate),/旧版待恢复/);assert.equal(next.status().lastError,"");
  await next.cacheDocument({id:"note",ystate:append((await durableRecord(next,"note")).ystate," · 另一个验证失败稿")});server.validationStatus=400;await next.sync();assert.equal(next.status().conflicts[0].kind,"validation");const restored=await next.restore(healthy.id);assert.ok(restored.preserved);assert.equal(next.data.documents.note.blocked,false);server.validationStatus=0;await next.maintenance();assert.equal(next.status().pending,0);assert.equal(next.status().conflicts.length,0);const preserved=await backupData(next,restored.preserved);assert.match(text(preserved.data.documents.note.ystate),/另一个验证失败稿/);
});

test("增量备份复用未变笔记与附件，无变化和运行时间更新均不创建版本，单篇修改仅新增小对象",async t=>{
  const {store,server}=await fixture(t),bytes=await largeAttachment(server);addRemote(server);await store.download();
  const first=await store.backup(),root=await store.backupRoot(),before=await rawBackup(store,first.id),objectsBefore=await fs.readdir(path.join(root,"objects")),assetFile=path.join(root,"objects",server.doc.assets[0].hash),stat=await fs.stat(assetFile);
  assert.equal(first.incremental,true);assert.equal(first.skipped,false);assert.equal(first.assets,1);assert.equal(before.format,"anote-chunked-backup");assert.equal(before.version,3);assert.ok(!before.data);assert.ok(first.addedBytes>bytes.length);
  store.data.lastBackup="2000-01-01T00:00:00.000Z";store.data.lastPullAttempt=new Date().toISOString();store.data.lastCacheUpdate=new Date().toISOString();store.data.lastDownload=new Date().toISOString();store.data.documents.note.downloadedAt=new Date().toISOString();store.data.documents.note.metadata=Object.fromEntries(Object.entries(store.data.documents.note.metadata).reverse());
  const skipped=await store.backup();assert.equal(skipped.skipped,true);assert.equal(skipped.id,first.id);assert.equal(skipped.addedBytes,0);assert.ok(skipped.reusedBytes>=bytes.length);assert.equal((await store.listBackups()).length,1);assert.deepEqual(await fs.readdir(path.join(root,"objects")),objectsBefore);
  await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 增量改一篇")});const second=await store.backup(),after=await rawBackup(store,second.id);
  assert.equal(second.skipped,false);assert.notEqual(after.documents.note.hash,before.documents.note.hash);assert.equal(after.documents.second.hash,before.documents.second.hash);assert.equal(after.index.hash,before.index.hash);assert.ok((await fs.readdir(path.join(root,"objects"))).length>objectsBefore.length);assert.ok(second.addedBytes<bytes.length/8);assert.equal(second.addedBytes,after.addedBytes);
  const next=await fs.stat(assetFile);assert.equal(next.ino,stat.ino);assert.equal(next.mtimeMs,stat.mtimeMs);assert.deepEqual(await fs.readFile(assetFile),bytes);
});

test("降低保留数且内容未变仍清理旧版本和无引用对象，保留版本共享的对象保持可恢复",async t=>{
  const {store,server}=await fixture(t);addRemote(server);await store.download();const first=await store.backup(),a=await rawBackup(store,first.id);
  await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 第一处变化")});const second=await store.backup(),b=await rawBackup(store,second.id);
  await store.cacheDocument({id:"second",ystate:append((await durableRecord(store,"second")).ystate," · 第二处变化")});const third=await store.backup(),c=await rawBackup(store,third.id),root=await store.backupRoot();
  assert.equal((await store.listBackups()).length,3);await store.configure({retention:2});const unchanged=await store.backup();assert.equal(unchanged.skipped,true);assert.equal(unchanged.id,third.id);assert.equal((await store.listBackups()).length,2);
  await assert.rejects(()=>fs.stat(path.join(root,"objects",a.documents.note.hash)),{code:"ENOENT"});await fs.stat(path.join(root,"objects",b.documents.second.hash));await backupData(store,second.id);await backupData(store,third.id);
  await store.configure({retention:1});assert.equal((await store.backup()).skipped,true);assert.equal((await store.listBackups()).length,1);await assert.rejects(()=>fs.stat(path.join(root,"objects",b.documents.second.hash)),{code:"ENOENT"});await fs.stat(path.join(root,"objects",c.files[0].hash));await backupData(store,third.id);
});

test("原v1全量备份可恢复，升级从已校验旧附件硬链接入对象池，旧client不会识别新快照",async t=>{
  const {store,server}=await fixture(t),bytes=await largeAttachment(server);await store.download();const legacy=await legacyBackup(store),old=await rawBackup(store,legacy.id),first=await store.backup(),root=await store.backupRoot(),manifest=await rawBackup(store,first.id);
  assert.ok(first.addedBytes<bytes.length/8);assert.equal((await fs.stat(path.join(root,"objects",old.files[0].hash))).ino,(await fs.stat(path.join(legacy.directory,old.files[0].path))).ino);assert.notEqual(manifest.format,"anote-offline-backup");
  await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · v2期间的修改")});await store.configure({retention:1});const restored=await store.restore(legacy.id);assert.equal(text((await durableRecord(store,"note")).ystate),"初稿");assert.match(text((await backupData(store,restored.preserved)).data.documents.note.ystate),/v2期间的修改/);await backupData(store,legacy.id);assert.ok((await store.listBackups()).length>=2);
  await store.backup();assert.equal((await store.listBackups()).length,1);await assert.rejects(()=>fs.stat(legacy.directory),{code:"ENOENT"});
});

test("完整账号备份目录可在原工作副本丢失后独立恢复正文、附件及缩略图，附件计数不重复",async t=>{
  const {store,server,session,profile,fetcher,bytes}=await fixture(t),thumbnail=Buffer.from("independent preview"),hash=createHash("sha256").update(thumbnail).digest("hex");
  server.doc.assets[0].thumbnail={url:"/api/assets/video/thumbnail",mime:"image/jpeg",hash,bytes:thumbnail.length};server.thumbnailFiles.set("video",thumbnail);await store.download();const first=await store.backup();assert.equal(first.assets,1);const raw=await rawBackup(store,first.id);assert.equal(raw.files.length,2);assert.equal((await store.listBackups())[0].assets,1);
  await store.close();await fs.rm(profile,{recursive:true,force:true});const next=await new OfflineStore(session,()=>{},{fetch:fetcher}).load();t.after(()=>next.close());await next.configure({backupDirectory:store.data.config.backupDirectory,backupIntervalMinutes:0});session.settings.offline=true;
  const result=await next.restore(first.id);assert.ok(result.preserved);assert.equal(text((await durableRecord(next,"note")).ystate),"初稿");assert.deepEqual(Buffer.from(await (await read(next,"assets/video/file")).arrayBuffer()),bytes);assert.deepEqual(Buffer.from(await (await read(next,"assets/video/thumbnail")).arrayBuffer()),thumbnail);
});

test("损坏或缺失v2对象拒绝恢复且保留当前稿，坏清单不作为无变化基准；正确原件可修复坏对象",async t=>{
  const {store}=await fixture(t);await store.download();const first=await store.backup(),root=await store.backupRoot(),raw=await rawBackup(store,first.id),asset=path.join(root,"objects",raw.files[0].hash),current=(await durableRecord(store,"note")).ystate;
  await fs.writeFile(asset,"corrupted");await assert.rejects(()=>store.restore(first.id),/损坏/);assert.equal((await durableRecord(store,"note")).ystate,current);const repaired=await store.backup();assert.equal(repaired.skipped,true);assert.ok(repaired.addedBytes>0);await backupData(store,first.id);
  const missing=path.join(root,"objects",raw.documents.note.hash);await fs.unlink(missing);await assert.rejects(()=>store.restore(first.id),/损坏/);assert.equal((await durableRecord(store,"note")).ystate,current);await store.backup();await backupData(store,first.id);
  raw.index.hash="0".repeat(64);await fs.writeFile(path.join(first.directory,"manifest.json"),JSON.stringify(raw));const healthy=await store.backup();assert.equal(healthy.skipped,false);assert.notEqual(healthy.id,first.id);await backupData(store,healthy.id);assert.equal(text((await durableRecord(store,"note")).ystate),"初稿");
});

test("备份提交磁盘满失败不发布半份清单或清理旧版本，仅清自己的临时文件；重试可完成",async t=>{
  const {store}=await fixture(t);await store.download();await store.configure({retention:1});const first=await store.backup(),root=await store.backupRoot();await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 未提交的新稿")});
  const restore=await workerSetup(store,`const rename=fs.rename;fs.rename=async(source,target)=>{if(path.basename(source).startsWith('.pending-'))throw Object.assign(new Error('disk full during commit'),{code:'ENOSPC'});return rename(source,target);};`);
  await assert.rejects(()=>store.backup(),{code:"ENOSPC"});restore();assert.equal((await store.listBackups())[0].id,first.id);assert.equal((await fs.readdir(root)).some(name=>name.startsWith(".pending-")),false);assert.deepEqual(await fs.readdir(path.join(root,"locks")),[]);await backupData(store,first.id);
  const second=await store.backup();assert.notEqual(second.id,first.id);assert.equal((await store.listBackups()).length,1);assert.match(text((await backupData(store,second.id)).data.documents.note.ystate),/未提交的新稿/);
});

test("备份路径与旧格式附件路径拒绝越界和符号链接，恢复复制失败不会截断已有附件",async t=>{
  const {store,bytes}=await fixture(t);await store.download();const old=await legacyBackup(store),manifest=await rawBackup(store,old.id),original=path.join(store.root,manifest.files[0].path),originalBytes=await fs.readFile(original),current=(await durableRecord(store,"note")).ystate;
  const outside=Buffer.from("fake local index"),invalid={path:"index.json",hash:createHash("sha256").update(outside).digest("hex"),bytes:outside.length};await fs.writeFile(path.join(old.directory,"index.json"),outside);manifest.files.push(invalid);await fs.writeFile(path.join(old.directory,"manifest.json"),JSON.stringify(manifest));await assert.rejects(()=>store.restore(old.id),/路径/);assert.equal((await durableRecord(store,"note")).ystate,current);
  manifest.files.pop();await fs.writeFile(path.join(old.directory,"manifest.json"),JSON.stringify(manifest));const repository=new BackupRepository(await store.backupRoot(),{identity:store.identity,schema:EDITOR_SCHEMA_VERSION});
  // Restore skips an already correct attachment instead of opening it for write.
  const before=await fs.stat(original);await store.restore(old.id);assert.equal((await fs.stat(original)).mtimeMs,before.mtimeMs);assert.deepEqual(await fs.readFile(original),originalBytes);
  // A different (versioned) original is copied via a temp file; commit failure
  // leaves an existing target unchanged and removes only that restore temp.
  const target="assets/atomic-restore",existing=Buffer.from("keep existing bytes"),source=path.join(old.directory,manifest.files[0].path);await fs.writeFile(path.join(store.root,target),existing);
  const rename=fs.rename,method=t.mock.method(fs,"rename",async function(from,to){if(String(from).includes(".restore-"))throw Object.assign(new Error("restore disk full"),{code:"ENOSPC"});return rename(from,to);});
  await assert.rejects(()=>repository.exclusive(()=>repository.restoreFiles(store.root,[{...manifest.files[0],path:target,source}])) ,{code:"ENOSPC"});method.mock.restore();assert.deepEqual(await fs.readFile(path.join(store.root,target)),existing);assert.equal((await fs.readdir(path.join(store.root,"assets"))).some(name=>name.includes(".restore-")),false);assert.deepEqual(originalBytes,bytes);
});

test("同账号多个备份/恢复实例并发互斥，失败claim不会清除持有者且崩溃进程claim可安全回收",async t=>{
  const {store}=await fixture(t),root=await store.backupRoot(),a=new BackupRepository(root,{identity:store.identity,schema:EDITOR_SCHEMA_VERSION}),b=new BackupRepository(root,{identity:store.identity,schema:EDITOR_SCHEMA_VERSION});
  let release,entered;const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),first=a.exclusive(async()=>{entered();await held;await a.assertLock();});await started;
  await assert.rejects(()=>a.exclusive(()=>assert.fail("must not enter twice")),/正在进行/);await assert.rejects(()=>b.exclusive(()=>assert.fail("must not enter concurrently")),/正在进行/);await a.assertLock();release();await first;assert.deepEqual(await fs.readdir(path.join(root,"locks")),[]);
  const host=createHash("sha256").update(os.hostname()).digest("hex").slice(0,16),dead=path.join(root,"locks",host+"-2147483647-"+randomUUID()+".lock");await fs.writeFile(dead,"");await b.exclusive(async()=>b.assertLock());assert.deepEqual(await fs.readdir(path.join(root,"locks")),[]);
});

test("重新取得互斥权后清理中断副本和无引用完整对象，未知文件与损坏清单可能引用的对象保守保留",async t=>{
  const {store}=await fixture(t);await store.download();const first=await store.backup(),root=await store.backupRoot(),repo=new BackupRepository(root,{identity:store.identity,schema:EDITOR_SCHEMA_VERSION}),temporary=path.join(root,"objects",".write-"+randomUUID()+".tmp"),pending=path.join(root,".pending-"+randomUUID()),orphan=Buffer.from("uncommitted object"),orphanHash=createHash("sha256").update(orphan).digest("hex");
  await fs.writeFile(temporary,Buffer.alloc(1024*1024));await fs.mkdir(pending);await fs.writeFile(path.join(pending,"manifest.json"),"incomplete");await fs.writeFile(path.join(root,"objects",orphanHash),orphan);await fs.writeFile(path.join(root,"objects","keep-unknown-file"),"owned elsewhere");
  await repo.exclusive(()=>repo.assertLock());await assert.rejects(()=>fs.stat(temporary),{code:"ENOENT"});await assert.rejects(()=>fs.stat(pending),{code:"ENOENT"});await assert.rejects(()=>fs.stat(path.join(root,"objects",orphanHash)),{code:"ENOENT"});assert.equal(await fs.readFile(path.join(root,"objects","keep-unknown-file"),"utf8"),"owned elsewhere");await backupData(store,first.id);
  const broken=path.join(root,(Date.now()+1000)+"-"+randomUUID()),manifest=await rawBackup(store,first.id);manifest.index.hash="0".repeat(64);await fs.mkdir(broken);await fs.writeFile(path.join(broken,"manifest.json"),JSON.stringify(manifest));await fs.writeFile(path.join(root,"objects",orphanHash),orphan);
  await repo.exclusive(()=>repo.assertLock());assert.deepEqual(await fs.readFile(path.join(root,"objects",orphanHash)),orphan);await fs.rm(broken,{recursive:true});await repo.exclusive(()=>repo.assertLock());await assert.rejects(()=>fs.stat(path.join(root,"objects",orphanHash)),{code:"ENOENT"});await backupData(store,first.id);
});

test("空工作副本恢复已撤权备份仍拒绝读取，旧备份不能清除已知访问拒绝",async t=>{
  const {store,session,profile,fetcher}=await fixture(t);await store.download();await store.denyDocument("note",403);const first=await store.backup();await store.close();await fs.rm(profile,{recursive:true,force:true});
  const next=await new OfflineStore(session,()=>{},{fetch:fetcher}).load();t.after(()=>next.close());await next.configure({backupDirectory:store.data.config.backupDirectory,backupIntervalMinutes:0});await next.restore(first.id);
  assert.equal((await read(next,"documents/note")).status,403);assert.equal((await read(next,"assets/video/file")).status,403);assert.equal(next.data.documents.note.unavailable,true);assert.equal(next.data.documents.note.permissionConflict,true);assert.equal(next.status().conflicts[0].kind,"permission");assert.ok((await fs.readdir(path.join(next.root,"private-backups"))).length);
});

test("不支持硬链接的备份盘从v1安全回退复制，真正I/O失败仍拒绝且保留旧版",async t=>{
  const first=await fixture(t),bytes=await largeAttachment(first.server);await first.store.download();const legacy=await legacyBackup(first.store),root=await first.store.backupRoot(),raw=await rawBackup(first.store,legacy.id);
  // Damaged unrelated legacy entries are not candidate sources for new data.
  raw.files.push({path:"../outside",hash:"0".repeat(64),bytes:1},{path:"assets/invalid",hash:"not-a-hash",bytes:-1});await fs.writeFile(path.join(legacy.directory,"manifest.json"),JSON.stringify(raw));
  const restore=await workerSetup(first.store,`fs.link=async()=>{throw Object.assign(new Error('filesystem does not support hardlinks'),{code:'EOPNOTSUPP'});};`);
  const created=await first.store.backup();restore();assert.ok(created.addedBytes>bytes.length);assert.notEqual((await fs.stat(path.join(root,"objects",raw.files[0].hash))).ino,(await fs.stat(path.join(legacy.directory,raw.files[0].path))).ino);await backupData(first.store,created.id);
  const second=await fixture(t);await second.store.download();const old=await legacyBackup(second.store),restoreIO=await workerSetup(second.store,`fs.link=async()=>{throw Object.assign(new Error('actual device I/O error'),{code:'EIO'});};`);
  await assert.rejects(()=>second.store.backup(),{code:"EIO"});restoreIO();assert.equal((await second.store.listBackups())[0].id,old.id);await backupData(second.store,old.id);
});

test("重开或系统时间回退时版本时钟推进超过已有版本，retention1不会删除刚创建的新备份",async t=>{
  const {store,reopen}=await fixture(t);await store.download();await store.configure({retention:1});const first=await store.backup(),root=await store.backupRoot(),future=Date.now()+86400000,renamed=future+"-"+randomUUID();await fs.rename(first.directory,path.join(root,renamed));
  const next=await reopen();await next.cacheDocument({id:"note",ystate:append((await durableRecord(next,"note")).ystate," · 时间回退后的新稿")});const second=await next.backup();assert.ok(Number(second.id.split("-")[0])>future);assert.equal((await next.listBackups())[0].id,second.id);assert.equal((await next.listBackups()).length,1);await fs.stat(second.directory);assert.match(text((await backupData(next,second.id)).data.documents.note.ystate),/时间回退后的新稿/);await assert.rejects(()=>fs.stat(path.join(root,renamed)),{code:"ENOENT"});
});

test("手动删除中间时间点只回收独有对象，保留共享附件、其他备份和当前笔记",async t=>{
  const {store,server,bytes}=await fixture(t);addRemote(server);await store.download();const first=await store.backup(),a=await rawBackup(store,first.id);
  await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 中间版本")});const middle=await store.backup(),b=await rawBackup(store,middle.id);
  await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 最新版本")});const latest=await store.backup(),c=await rawBackup(store,latest.id),root=await store.backupRoot(),current=await durableData(store);
  const result=await store.deleteBackup(middle.id);assert.deepEqual(result.backups.map(item=>item.id),[latest.id,first.id]);assert.deepEqual(await durableData(store),current);await assert.rejects(()=>fs.stat(middle.directory),{code:"ENOENT"});await assert.rejects(()=>fs.stat(path.join(root,"objects",b.documents.note.hash)),{code:"ENOENT"});
  await fs.stat(path.join(root,"objects",a.documents.note.hash));await fs.stat(path.join(root,"objects",c.documents.note.hash));await fs.stat(path.join(root,"objects",b.documents.second.hash));assert.deepEqual(await fs.readFile(path.join(root,"objects",b.files[0].hash)),bytes);await backupData(store,first.id);await backupData(store,latest.id);assert.deepEqual(Buffer.from(await (await read(store,"assets/video/file")).arrayBuffer()),bytes);
});

test("允许删除最新和唯一备份，当前原稿与附件保留，之后可重新备份及恢复",async t=>{
  const {store,bytes}=await fixture(t);await store.download();const first=await store.backup();await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 最新本地稿")});const latest=await store.backup(),current=await durableData(store),index=await fs.readFile(path.join(store.root,"index.json"));
  assert.deepEqual((await store.deleteBackup(latest.id)).backups.map(item=>item.id),[first.id]);assert.deepEqual((await store.deleteBackup(first.id)).backups,[]);assert.deepEqual(await store.listBackups(),[]);assert.deepEqual(await durableData(store),current);assert.deepEqual(await fs.readFile(path.join(store.root,"index.json")),index);assert.deepEqual(await fs.readdir(path.join(await store.backupRoot(),"objects")),[]);assert.deepEqual(Buffer.from(await (await read(store,"assets/video/file")).arrayBuffer()),bytes);
  const replacement=await store.backup();assert.equal(replacement.skipped,false);await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 恢复前新稿")});const restored=await store.restore(replacement.id);assert.match(text((await backupData(store,restored.preserved)).data.documents.note.ystate),/恢复前新稿/);assert.equal(text((await durableRecord(store,"note")).ystate),text(current.documents.note.ystate));
});

test("删除旧版完整备份保留硬链接导入的增量对象；删除增量备份仍可恢复旧版",async t=>{
  const first=await fixture(t);await first.store.download();const legacy=await legacyBackup(first.store),incremental=await first.store.backup(),raw=await rawBackup(first.store,incremental.id),object=path.join(await first.store.backupRoot(),"objects",raw.files[0].hash);
  await first.store.deleteBackup(legacy.id);await assert.rejects(()=>fs.stat(legacy.directory),{code:"ENOENT"});await fs.stat(object);await backupData(first.store,incremental.id);
  const second=await fixture(t);await second.store.download();const old=await legacyBackup(second.store),newer=await second.store.backup();await second.store.deleteBackup(newer.id);assert.deepEqual((await second.store.listBackups()).map(item=>item.id),[old.id]);await backupData(second.store,old.id);await second.store.restore(old.id);assert.equal(text((await durableRecord(second.store,"note")).ystate),"初稿");
});

test("删除拒绝越界ID、其他身份/schema、损坏清单和符号链接，当前笔记与目标目录不变",async t=>{
  const {store,directory}=await fixture(t);await store.download();const selected=await store.backup(),root=await store.backupRoot(),original=await rawBackup(store,selected.id),current=await durableData(store);
  for(const invalid of [undefined,null,{},"../"+selected.id,path.join(root,selected.id),selected.id+"/../objects"]){await assert.rejects(()=>store.deleteBackup(invalid),/版本无效/);await fs.stat(selected.directory);}
  for(const patch of [{identity:{...store.identity,userId:"other"}},{identity:{...store.identity,serverURL:"https://other.example"}},{schema:999},{format:"unknown"},{fingerprint:"0".repeat(64)}]){
    await fs.writeFile(path.join(selected.directory,"manifest.json"),JSON.stringify({...original,...patch}));await assert.rejects(()=>store.deleteBackup(selected.id),/不匹配|清单无效/);await fs.stat(selected.directory);
  }
  await fs.writeFile(path.join(selected.directory,"manifest.json"),JSON.stringify(original));const legacy=await legacyBackup(store),old=await rawBackup(store,legacy.id);old.files[0].path="../outside";await fs.writeFile(path.join(legacy.directory,"manifest.json"),JSON.stringify(old));await assert.rejects(()=>store.deleteBackup(legacy.id),/路径无效/);await fs.stat(legacy.directory);
  const outside=path.join(directory,"outside"),linkId=Date.now()+"-"+randomUUID();await fs.mkdir(outside);await fs.writeFile(path.join(outside,"keep.txt"),"keep");await fs.symlink(outside,path.join(root,linkId));await assert.rejects(()=>store.deleteBackup(linkId),/符号链接/);assert.equal(await fs.readFile(path.join(outside,"keep.txt"),"utf8"),"keep");assert.deepEqual(await durableData(store),current);await backupData(store,selected.id);
});

test("删除与其他备份或恢复仓库互斥，竞争者不会移除持有者锁",async t=>{
  const {store}=await fixture(t);await store.download();const selected=await store.backup(),root=await store.backupRoot(),repository=new BackupRepository(root,{identity:store.identity,schema:EDITOR_SCHEMA_VERSION});
  let release,enter;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve),held=repository.exclusive(async()=>{enter();await gate;await repository.assertLock();});await entered;
  try{await assert.rejects(()=>store.deleteBackup(selected.id),/正在进行/);await repository.assertLock();await fs.stat(selected.directory);}finally{release();await held;}
  await store.deleteBackup(selected.id);assert.deepEqual(await store.listBackups(),[]);await assert.rejects(()=>store.deleteBackup(selected.id),/不匹配/);assert.deepEqual(await fs.readdir(path.join(root,"locks")),[]);
});

test("同一存储删除期间的新备份串行执行，删除失败仍能重试且不破坏当前稿",async t=>{
  const {store}=await fixture(t);await store.download();const first=await store.backup(),current=await durableData(store),entered=path.join(store.root,"delete-entered"),release=path.join(store.root,"delete-release");
  const restore=await workerSetup(store,`const remove=fs.rm;fs.rm=async(file,...options)=>{if(file===${JSON.stringify(first.directory)}){await fs.writeFile(${JSON.stringify(entered)},'entered');while(!(await fs.stat(${JSON.stringify(release)}).catch(()=>null)))await new Promise(resolve=>setTimeout(resolve,5));}return remove(file,...options);};`);
  const deleting=store.deleteBackup(first.id);await fileAppears(entered);const creating=store.backup();await fs.writeFile(release,"continue");await deleting;const next=await creating;restore();assert.notEqual(next.id,first.id);assert.equal(next.skipped,false);assert.deepEqual((await store.listBackups()).map(item=>item.id),[next.id]);assert.equal((await durableRecord(store,"note")).ystate,current.documents.note.ystate);await backupData(store,next.id);
  const restoreFailure=await workerSetup(store,`const remove=fs.rm;fs.rm=async(file,...options)=>{if(file===${JSON.stringify(next.directory)})throw Object.assign(new Error('permission denied'),{code:'EACCES'});return remove(file,...options);};`);await assert.rejects(()=>store.deleteBackup(next.id),{code:"EACCES"});restoreFailure();await backupData(store,next.id);await store.deleteBackup(next.id);assert.deepEqual(await store.listBackups(),[]);
});

test("v2完整笔记对象与v3分块备份共存、恢复及逐条删除，不依赖已删除的旧时间点",async t=>{
  const {store,bytes}=await fixture(t);await store.download();const legacy=await legacyIncrementalBackup(store),old=await rawBackup(store,legacy.id),upgraded=await store.backup();assert.equal((await rawBackup(store,upgraded.id)).version,3);await backupData(store,legacy.id);await backupData(store,upgraded.id);
  await store.cacheDocument({id:"note",ystate:append((await durableRecord(store,"note")).ystate," · 升级后的当前稿")});const restored=await store.restore(legacy.id);assert.match(text((await backupData(store,restored.preserved)).data.documents.note.ystate),/升级后的当前稿/);assert.equal(text((await durableRecord(store,"note")).ystate),"初稿");
  const root=await store.backupRoot();await store.deleteBackup(legacy.id);await assert.rejects(()=>fs.stat(path.join(root,"objects",old.documents.note.hash)),{code:"ENOENT"});await backupData(store,upgraded.id);await backupData(store,restored.preserved);assert.deepEqual(Buffer.from(await (await read(store,"assets/video/file")).arrayBuffer()),bytes);
});

test("v3分块或字段校验失败拒绝恢复并保留当前稿，正确本地内容可修复损坏分块",async t=>{
  const {store}=await fixture(t);await store.download();const first=await store.backup(),root=await store.backupRoot(),manifest=await rawBackup(store,first.id),envelope=JSON.parse(await fs.readFile(path.join(root,"objects",manifest.documents.note.hash),"utf8")),chunk=path.join(root,"objects",envelope.ystate.chunks[0].hash),original=await fs.readFile(chunk),current=(await durableRecord(store,"note")).ystate;
  await fs.writeFile(chunk,"broken");await assert.rejects(()=>store.restore(first.id),/损坏/);assert.equal((await durableRecord(store,"note")).ystate,current);const repaired=await store.backup();assert.equal(repaired.skipped,true);assert.ok(repaired.addedBytes>0);assert.deepEqual(await fs.readFile(chunk),original);await backupData(store,first.id);
  const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item),digest=bytes=>createHash("sha256").update(bytes).digest("hex");
  envelope.snapshot.hash="0".repeat(64);const buffer=Buffer.from(stable(envelope));manifest.documents.note={hash:digest(buffer),bytes:buffer.length};await fs.writeFile(path.join(root,"objects",manifest.documents.note.hash),buffer);manifest.fingerprint=digest(stable({index:manifest.index,documents:manifest.documents,files:manifest.files}));await fs.writeFile(path.join(first.directory,"manifest.json"),JSON.stringify(manifest));await assert.rejects(()=>store.restore(first.id),/字段缺失或损坏/);assert.equal((await durableRecord(store,"note")).ystate,current);
  envelope.snapshot.bytes++;const changed=Buffer.from(stable(envelope));manifest.documents.note={hash:digest(changed),bytes:changed.length};await fs.writeFile(path.join(root,"objects",manifest.documents.note.hash),changed);manifest.fingerprint=digest(stable({index:manifest.index,documents:manifest.documents,files:manifest.files}));await fs.writeFile(path.join(first.directory,"manifest.json"),JSON.stringify(manifest));await assert.rejects(()=>store.restore(first.id),/字段长度无效/);assert.equal((await durableRecord(store,"note")).ystate,current);
});

test("30篇72附件及2000项大TODO少量修改实际新增不足1MB，metadata与inflight不重复备份正文",async t=>{
  const {store,session}=await fixture(t);clearInterval(store.timer);session.settings.offline=true;
  const library={id:"library",name:"大TODO隔离库",kind:"personal",role:"admin"};store.data.libraries=[library];store.data.availableLibraries=[library];await fs.mkdir(path.join(store.root,"assets"),{recursive:true});
  const assets=[];for(let index=0;index<72;index++){const bytes=Buffer.alloc(64*1024,index+1),hash=createHash("sha256").update(bytes).digest("hex"),file="assets/large-"+index+"-"+hash;await fs.writeFile(path.join(store.root,file),bytes);assets.push({id:"large-"+index,kind:"file",mime:"application/octet-stream",hash,bytes:bytes.length,file,available:true});}
  const item=index=>({type:"taskItem",attrs:{checked:false},content:[{type:"paragraph",attrs:{blockId:"todo-"+index},content:[{type:"text",text:"待办事项纯文字 abcdefghijklmnop · ".repeat(44)+index}]}]});
  for(let index=0;index<30;index++){
    const value={type:"doc",content:index===0?[{type:"taskList",content:Array.from({length:2000},(_,i)=>item(i))}]:[{type:"paragraph",attrs:{blockId:"plain-"+index},content:[{type:"text",text:"普通笔记 "+index}]}]},doc=prosemirrorJSONToYDoc(schema,value,"default"),key="large-note-"+index;
    try{store.data.documents[key]={metadata:{id:key,space_id:library.id,title:"大TODO笔记 "+index,role:"admin",archived:false},ystate:encoded(doc),snapshot:json(doc),assets:assets.filter((_asset,i)=>i%30===index),serverTitle:"大TODO笔记 "+index};}finally{doc.destroy();}
  }
  await store.serial(()=>store.persist(...Object.keys(store.data.documents)));const root=await store.backupRoot();
  async function size(directory){let bytes=0;for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);bytes+=entry.isDirectory()?await size(file):(await fs.stat(file)).size;}return bytes;}
  const first=await store.backup(),initial=await rawBackup(store,first.id);assert.equal(first.documents,30);assert.equal(first.assets,72);const firstSize=await size(root),doc=clone((await durableRecord(store,"large-note-0")).ystate);
  try{const tasks=doc.getXmlFragment("default").get(0);doc.transact(()=>{tasks.get(100).setAttribute("checked",true);tasks.get(800).get(0).get(0).insert(0,"改三字");});await store.cacheDocument({id:"large-note-0",ystate:encoded(doc)});}finally{doc.destroy();}
  const edited=await store.backup(),editedSize=await size(root);assert.equal(edited.addedBytes,editedSize-firstSize);assert.ok(edited.addedBytes<1024*1024,`少改实际新增 ${edited.addedBytes} B`);assert.deepEqual((await rawBackup(store,edited.id)).files,initial.files);
  const beforeMeta=await size(root),legacyRecord=await store.hydrateRecord("large-note-0");legacyRecord.metadata.ystate=legacyRecord.ystate;legacyRecord.metadata.snapshot=legacyRecord.snapshot;legacyRecord.metadata.assets=legacyRecord.assets;await store.serial(()=>store.persist("large-note-0"));
  const legacyOnly=await store.backup();assert.equal(legacyOnly.skipped,true);assert.equal(legacyOnly.id,edited.id);assert.equal(await size(root),beforeMeta);
  // Change the old cache directly so cacheDocument's own sanitization cannot
  // hide a regression in capture of an untouched pre-upgrade record.
  legacyRecord.metadata.updated_at="2026-11-06T00:00:01Z";await store.serial(()=>store.persist("large-note-0"));const meta=await store.backup();assert.equal(meta.skipped,false);assert.equal(meta.addedBytes,(await size(root))-beforeMeta);assert.ok(meta.addedBytes<128*1024);
  const beforeInflight=await size(root),record=await store.hydrateRecord("large-note-0");record.inflight={schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:record.ystate};record.downloadedAt=new Date().toISOString();store.data.lastCacheUpdate=new Date().toISOString();await store.serial(()=>store.persist("large-note-0"));const inflight=await store.backup();assert.equal(inflight.skipped,true);assert.equal(inflight.id,meta.id);assert.equal(inflight.addedBytes,0);assert.equal(await size(root),beforeInflight);
  await store.deleteBackup(first.id);await store.deleteBackup(edited.id);const restored=await backupData(store,meta.id);assert.equal(Object.keys(restored.data.documents).length,30);assert.equal(restored.files.length,72);assert.equal(restored.data.documents["large-note-0"].ystate,(await durableRecord(store,"large-note-0")).ystate);assert.equal(restored.data.documents["large-note-0"].inflight,undefined);assert.deepEqual(restored.data.documents["large-note-0"].pending,record.pending);for(const field of ["ystate","snapshot","assets"])assert.equal(Object.hasOwn(restored.data.documents["large-note-0"].metadata,field),false);
});

test("已授权正文后台副本排队不阻塞调用者，关闭等待已接受的副本落盘",async t=>{
  const {store,server}=await fixture(t);await store.download();
  let release,enter;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve);
  const held=store.serial(async()=>{enter();await gate;});await entered;
  const next={...server.doc,title:"received authorized body"},observed=store.observeBackground(new URL("/api/documents/note",server.doc.url||store.identity.serverURL),next);
  let finished=false;const closing=store.close().then(()=>{finished=true;});
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(finished,false);assert.notEqual(store.data.documents.note.metadata.title,next.title);
  release();await Promise.all([held,observed,closing]);
  const saved=JSON.parse(await fs.readFile(path.join(store.root,"documents/note.json"),"utf8"));assert.equal(saved.metadata.title,next.title);assert.equal(store.active.size,0);
});

test("后台副本磁盘错误可见且可重试，已存在的副本与权限拒绝保护不变",async t=>{
  const {store,server}=await fixture(t);await store.download();const current=await fs.readFile(path.join(store.root,"documents/note.json"),"utf8");
  const restore=await workerSetup(store,`const rename=fs.rename;fs.rename=async(source,target)=>{if(target===${JSON.stringify(path.join(store.root,"documents/note.json"))})throw Object.assign(new Error('no space for replica'),{code:'ENOSPC'});return rename(source,target);};`,"document");
  await assert.rejects(store.observeBackground(new URL("/api/documents/note",store.identity.serverURL),{...server.doc,title:"new metadata"}),{code:"ENOSPC"});
  assert.match(store.status().lastError,/本地副本更新失败.*no space/);assert.equal(await fs.readFile(path.join(store.root,"documents/note.json"),"utf8"),current);restore();
  await store.observeBackground(new URL("/api/documents/note",store.identity.serverURL),{...server.doc,title:"new metadata"});assert.equal(store.status().lastError,"");assert.equal(store.data.documents.note.metadata.title,"new metadata");
  await store.denyDocument("note",403);await store.observeBackground(new URL("/api/documents/note",store.identity.serverURL),server.doc);assert.equal((await read(store,"documents/note")).status,403);
});


test("知识库归档保留离线草稿和附件，重启只读，恢复后手动合并继续同步",async t=>{
  const {store,server,session,reopen,bytes}=await fixture(t);await store.download();
  const changed=append(server.doc.ystate," 断网保留的草稿");await store.cacheDocument({id:"note",ystate:changed,metadata:server.doc,local:true});
  Object.assign(server.libraries[0],{archived:true,archive_revision:1,can_create:false});Object.assign(server.doc,{role:"viewer",library_archived:true,library_archive_revision:1});
  await store.sync();assert.equal(server.commits,0);assert.equal(store.status().conflicts[0].kind,"archive");
  await store.download();assert.equal(!!store.data.documents.note.unavailable,false);assert.equal(store.status().pending,1);assert(text((await durableRecord(store)).ystate).includes("断网保留的草稿"));
  await assert.rejects(()=>store.queueTitle("note","blocked"),/归档/);await assert.rejects(()=>store.createDocument({space_id:"library",title:"blocked"}),/创建权限/);
  const next=await reopen();session.settings.offline=true;const note=await (await read(next,"documents/note")).json();assert.equal(note.library_archived,true);assert.equal(note.role,"viewer");assert(text(note.ystate).includes("断网保留的草稿"));
  const asset=await read(next,"assets/video/file");assert.deepEqual(Buffer.from(await asset.arrayBuffer()),bytes);
  session.settings.offline=false;Object.assign(server.libraries[0],{archived:false,archive_revision:2,can_create:true});Object.assign(server.doc,{role:"admin",library_archived:false,library_archive_revision:2});
  await next.resolveConflict("note","local-title");await next.sync();assert.equal(next.status().pending,0);assert.equal(server.commits,1);assert(text(server.doc.ystate).includes("断网保留的草稿"));
});

test("归档库中尚未上传的新笔记保持可读，旧备份不能恢复编辑权限",async t=>{
  const {store,server}=await fixture(t);await store.download();const backup=await store.backup();
  const draft=await store.createDocument({space_id:"library",title:"未上传的新笔记"});
  Object.assign(server.libraries[0],{archived:true,archive_revision:1,can_create:false});Object.assign(server.doc,{role:"viewer",library_archived:true,library_archive_revision:1});
  await store.download();assert.equal(store.isUnavailable(draft.id),false);assert.equal(store.data.documents[draft.id].archiveConflict,true);assert.equal((await (await read(store,"documents/"+draft.id)).json()).role,"viewer");
  await store.restore(backup.id);assert.equal(store.data.availableLibraries[0].archived,true);assert.equal((await (await read(store,"documents/note")).json()).role,"viewer");await assert.rejects(()=>store.createDocument({space_id:"library",title:"blocked"}),/创建权限/);
});


test("归档前的离线新建草稿可在库恢复后重新检查权限并继续排队",async t=>{
  const {store,server}=await fixture(t);await store.download();const draft=await store.createDocument({space_id:"library",title:"等待恢复的新稿"});
  Object.assign(server.libraries[0],{archived:true,archive_revision:1,can_create:false});Object.assign(server.doc,{role:"viewer",library_archived:true,library_archive_revision:1});await store.download();
  await assert.rejects(()=>store.resolveConflict(draft.id,"local-title"),/仍已归档/);
  Object.assign(server.libraries[0],{archived:false,archive_revision:2,can_create:true});Object.assign(server.doc,{role:"admin",library_archived:false,library_archive_revision:2});
  await store.resolveConflict(draft.id,"local-title");assert.equal(store.data.documents[draft.id].blocked,false);assert.equal(store.data.documents[draft.id].pending.create.space_id,"library");assert.equal((await (await read(store,"documents/"+draft.id)).json()).role,"admin");await store.queueTitle(draft.id,"恢复后可以编辑");
});

test("知识库归档状态未变时刷新列表不重写笔记副本",async t=>{
  const {store,server}=await fixture(t);await store.download();const url=new URL("anote://app/api/spaces");await store.observe(url,server.libraries);
  const file=path.join(store.root,"documents/note.json"),before=await fs.stat(file);assert.equal(await store.observe(url,server.libraries),false);assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);
});

test("归档草稿失去阅读权限后优先提示权限变化，正文拒绝访问且私有草稿保留",async t=>{
  const {store,server}=await fixture(t);await store.download();await store.cacheDocument({id:"note",ystate:append(server.doc.ystate," 私有草稿"),metadata:server.doc,local:true});
  Object.assign(server.libraries[0],{archived:true,archive_revision:1,can_create:false});Object.assign(server.doc,{role:"viewer",library_archived:true,library_archive_revision:1});await store.sync();assert.equal(store.status().conflicts[0].kind,"archive");
  await store.denyDocument("note",403);const conflict=store.status().conflicts[0];assert.equal(conflict.kind,"permission");assert.equal(conflict.title,"访问权限已变化的本地修改");assert.equal((await read(store,"documents/note")).status,403);
  const record=await durableRecord(store);assert(text(record.ystate).includes("私有草稿"));assert(await fs.stat(path.join(store.root,record.privateBackupFile)));
});


test("schema 8 pending CRDT requests upgrade to schema 9 with a fresh operation id and preserve the title intent",async t=>{
  const {store,server}=await fixture(t);await store.download();
  const record=await store.hydrateRecord("note"),oldId=randomUUID(),original=record.ystate;
  record.pending={opId:oldId,revision:1,title:"升级后保留标题",baseTitle:record.metadata.title};
  record.inflight={schema:8,opId:oldId,ystate:original,title:"升级后保留标题",baseTitle:record.metadata.title};
  await store.serial(()=>store.persist("note"));await store.sync();
  assert.equal(server.postBodies.at(-1).schema,9);assert.notEqual(server.postBodies.at(-1).opId,oldId);
  assert.equal(server.postBodies.at(-1).ystate,original);assert.equal(server.doc.title,"升级后保留标题");
  assert.equal(store.data.documents.note.pending,undefined);assert.equal(store.data.documents.note.inflight,undefined);
});

test("schema 9 lists and restores schema 8 backups while older readers reject newer formats",async t=>{
  const {store}=await fixture(t);await store.download();const prior=await legacyBackup(store);
  assert((await store.listBackups()).some(value=>value.id===prior.id));await store.restore(prior.id);
  const root=await store.backupRoot(),current=await store.backup(),oldReader=new BackupRepository(root,{identity:store.identity,schema:8});
  assert((await oldReader.manifests()).some(value=>value.id===prior.id));
  await assert.rejects(()=>oldReader.read(current.id),/不匹配/);
});


test("schema upgrade preserves an older in-flight state separately from a newer queued edit",async t=>{
  const {store,server}=await fixture(t);await store.download();
  const record=await store.hydrateRecord("note"),oldId=randomUUID(),oldState=record.ystate;
  record.pending={opId:oldId,revision:1};record.inflight={schema:8,opId:oldId,ystate:oldState};
  await store.serial(()=>store.persist("note"));
  await store.cacheDocument({id:"note",ystate:append(oldState," · newer queued edit"),local:true});
  const newId=store.data.documents.note.pending.opId;assert.notEqual(newId,oldId);await store.sync();
  assert.equal(server.postBodies[0].ystate,oldState);assert.notEqual(server.postBodies[0].opId,oldId);
  assert.equal(store.data.documents.note.pending.opId,newId);await store.sync();assert.match(text(server.doc.ystate),/newer queued edit/);assert.equal(store.data.documents.note.pending,undefined);
});

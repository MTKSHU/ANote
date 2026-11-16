import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as Y from "yjs";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { schema } from "@anote/document-model";
import { PersonalStore } from "../../apps/desktop/main/personal-store.mjs";
import { createDocumentUpdateCapture } from "../../apps/desktop/renderer/document-save.ts";
import { createHash,randomUUID } from "node:crypto";
const digest = (data) => createHash("sha256").update(data).digest("hex");
async function fixture(t) {
  const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "simple-personal-"),
    ),
    store = await new PersonalStore(directory).load();
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const api = async (endpoint, method = "GET", body, status = 200) => {
    const url = new URL("anote://app/api/" + endpoint),
      response = await store.respond(
        new Request(url, {
          method,
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
                headers: { "Content-Type": "application/json" },
              }),
        }),
        url,
      );
    const value = await response.json();
    assert.equal(response.status, status, value.error || endpoint);
    return value;
  };
  const book = await api("spaces", "POST", {
      name: "个人研究",
      kind: "personal",
    }),
    note = await api("documents", "POST", {
      title: "离线记录",
      space_id: book.id,
    });
  async function edit(content) {
    const value = await api("documents/" + note.id),
      doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Buffer.from(value.ystate, "base64"));
      const fragment = doc.getXmlFragment("default"),
        pm = initProseMirrorDoc(fragment, schema);
      updateYFragment(
        doc,
        fragment,
        schema.nodeFromJSON({ type: "doc", content }),
        pm.meta,
      );
      await api(`documents/${note.id}/local-state`, "PUT", {
        ystate: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      });
    } finally {
      doc.destroy();
    }
  }
  return { store, directory, api, book, note, edit };
}
test("个人存储实际接收增量、纯删除和重放，冷启动保留正文及未变化的历史",async t=>{
  const {store,directory,api,note,edit}=await fixture(t);
  await edit([{type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text:"需要保留的个人待办正文"}]}]);
  const document=new Y.Doc();Y.applyUpdate(document,Buffer.from((await api(`documents/${note.id}`)).ystate,"base64"));
  const history="unchanged retained state ".repeat(4000);document.getMap("personal-delta-history").set("record",history);
  const capture=createDocumentUpdateCapture(document),save=async batch=>api(`documents/${note.id}/local-state`,"PUT",{ystate:batch.ystate});
  try{
    const baseline=capture.capture();assert.ok(baseline.ystate.length>100000);await save(baseline);capture.acknowledge(baseline);
    const text=document.getXmlFragment("default").get(0).get(0);text.insert(text.length,"，追加几个字");
    const insertion=capture.capture();assert.ok(insertion.ystate.length<512);await save(insertion);capture.acknowledge(insertion);
    const vector=Y.encodeStateVector(document);text.delete(0,3);assert.deepEqual(Y.encodeStateVector(document),vector);
    const deletion=capture.capture();assert.ok(deletion.ystate.length<512);await save(deletion);await save(deletion);capture.acknowledge(deletion);
    await save(insertion);await save(baseline);
    const current=await api(`documents/${note.id}`);assert.equal(current.snapshot.content[0].content[0].text,text.toString());
    await store.close();const reopened=await new PersonalStore(directory).load();
    try{const saved=await reopened.record(note.id),copy=new Y.Doc();try{Y.applyUpdate(copy,Buffer.from(saved.ystate,"base64"));assert.equal(saved.snapshot.content[0].content[0].text,text.toString());assert.equal(copy.getMap("personal-delta-history").get("record"),history);}finally{copy.destroy();}}
    finally{await reopened.close();}
  }finally{capture.dispose();document.destroy();}
});
test("个人正文轮询仅在有变化时返回CRDT，仍吸收外部Markdown与标题变化",async t=>{
  const {directory,api,note,edit}=await fixture(t),blockId=randomUUID();
  await edit([{type:"paragraph",attrs:{blockId},content:[{type:"text",text:"poll source"}]}]);
  const first=await api(`documents/${note.id}`),same=await api(`documents/${note.id}?known_hash=${first.hash}`);
  assert.equal(same.unchanged,true);assert.equal(same.ystate,undefined);assert.equal(same.snapshot,undefined);
  await api(`documents/${note.id}`,"PATCH",{title:"renamed while polling"});
  assert.equal((await api(`documents/${note.id}?known_hash=${first.hash}`)).title,"renamed while polling");
  const markdown=path.join(directory,".anote/markdown",note.id+".md"),source=await fs.readFile(markdown,"utf8");
  assert.ok(source.includes(`id="${blockId}"`),"The external Markdown fixture needs the stable block ID assigned by the real editor");
  await fs.writeFile(markdown,source.replace("poll source","external poll update"));
  const changed=await api(`documents/${note.id}?known_hash=${first.hash}`);assert.notEqual(changed.hash,first.hash,JSON.stringify({markdownBefore:source,markdownAfter:await fs.readFile(markdown,"utf8"),syncWarning:changed.sync_warning,snapshot:changed.snapshot}));assert.equal(changed.sync_warning||"","");assert.equal(typeof changed.ystate,"string");assert.match(JSON.stringify(changed.snapshot),/external poll update/);
});
test("无需账号的个人库：正文保存、目录、重新打开与账号隔离", async (t) => {
  const { store, directory, api, book, note, edit } = await fixture(t);
  assert.equal(store.state().personal, true);
  assert.equal(store.state().token, null);
  const folder = await api(`spaces/${book.id}/folders`, "POST", {
    name: "实验记录",
  });
  await api(`documents/${note.id}`, "PATCH", { folder_id: folder.id });
  await edit([
    {
      type: "paragraph",
      attrs: { blockId: "body" },
      content: [{ type: "text", text: "断网写作" }],
    },
  ]);
  assert.equal(
    (await api("documents?q=" + encodeURIComponent("断网写作"))).length,
    1,
  );
  await store.close();
  const reopened = await new PersonalStore(directory).load();
  try {
    assert.equal(reopened.index.documents[0].folder_id, folder.id);
    assert.equal(
      (await reopened.record(note.id)).snapshot.content[0].content[0].text,
      "断网写作",
    );
    assert.equal(reopened.state().user.id, store.state().user.id);
  } finally {
    await reopened.close();
  }
});
test("已有目录锁和符号链接不能覆盖其他文件", async (t) => {
  const { store, directory, note } = await fixture(t);
  await assert.rejects(() => new PersonalStore(directory).load(), /另一客户端/);
  await store.close();
  const outside = path.join(directory, "outside");
  await fs.writeFile(outside, "原件");
  await fs.rm(path.join(store.root, "notes", note.id + ".json"));
  await fs.symlink(outside, path.join(store.root, "notes", note.id + ".json"));
  await assert.rejects(() => store.record(note.id), /符号链接/);
  assert.equal(await fs.readFile(outside, "utf8"), "原件");
});
test("个人模式目录和笔记混合排序持久化，移动目录防循环并保留笔记顺序", async(t)=>{
  const {store,directory,api,book,note}=await fixture(t);
  const f=await api(`spaces/${book.id}/folders`,"POST",{name:"父目录"}),child=await api(`spaces/${book.id}/folders`,"POST",{name:"子目录",parent_id:f.id});
  const second=await api("documents","POST",{space_id:book.id,title:"第二篇"});
  const read=()=>api(`spaces/${book.id}/catalog`);
  async function move(kind,id,parent_id,before=null,status=200) {return api(`spaces/${book.id}/catalog`,"PATCH",{revision:(await read()).revision,kind,id,parent_id,before},status);}
  await move("note",second.id,null,"folder:"+f.id);await move("note",note.id,child.id);
  await move("folder",f.id,child.id,null,400);
  await move("folder",child.id,null,"note:"+second.id);
  const ordered=await read();assert.deepEqual(ordered.items.filter(e=>!e.parent_id).map(e=>e.key),["folder:"+child.id,"note:"+second.id,"folder:"+f.id]);
  await api(`spaces/${book.id}/catalog`,"PATCH",{revision:"-1",kind:"note",id:note.id,parent_id:null},409);
  await store.close();const reopened=await new PersonalStore(directory).load();
  try {assert.deepEqual(reopened.index.spaces.find(s=>s.id===book.id).catalog_order,store.index.spaces.find(s=>s.id===book.id).catalog_order);assert.equal(reopened.index.documents.find(d=>d.id===note.id).folder_id,child.id);}
  finally {await reopened.close();}
});
test("个人模式删除目录保留内容和层级，Auto 偏好重开保留",async(t)=>{
  const {store,directory,api,book,note}=await fixture(t);
  const folder=await api(`spaces/${book.id}/folders`,"POST",{name:"删除目录"}),child=await api(`spaces/${book.id}/folders`,"POST",{name:"保留子目录",parent_id:folder.id});await api(`documents/${note.id}`,"PATCH",{folder_id:folder.id});const before=await store.record(note.id);
  await api(`spaces/${book.id}/folders/${folder.id}`,"DELETE");assert.equal((await api(`spaces/${book.id}/folders`)).find(f=>f.id===child.id).parent_id,null);assert.equal((await api(`documents/${note.id}`)).folder_id,null);assert.deepEqual(await store.record(note.id),before);
  await api("me/preferences","PATCH",{theme:"auto"});await store.close();const reopened=await new PersonalStore(directory).load();try{assert.equal(reopened.state().user.theme,"auto");assert.equal(reopened.index.documents.find(d=>d.id===note.id).folder_id,null);assert.ok(reopened.index.folders.some(f=>f.id===child.id));}finally{await reopened.close();}
});
test("本地 Markdown 改字双向合并；增强内容冲突保留原件和修改副本", async (t) => {
  const { store, api, note, edit } = await fixture(t);
  await edit([
    {
      type: "paragraph",
      attrs: { blockId: "body" },
      content: [{ type: "text", text: "原文" }],
    },
    {
      type: "mindMap",
      attrs: { blockId: "map" },
      content: [
        {
          type: "mindMapItem",
          attrs: { id: "r", x: 200, y: 100 },
          content: [{ type: "text", text: "主题" }],
        },
      ],
    },
  ]);
  const markdown = path.join(store.root, "markdown", note.id + ".md");
  await fs.writeFile(
    markdown,
    (await fs.readFile(markdown, "utf8")).replace("原文", "外部改字"),
  );
  await store.mutate(() => store.maintenance());
  const merged = await api("documents/" + note.id);
  assert.equal(merged.snapshot.content[0].content[0].text, "外部改字");
  assert.equal(merged.snapshot.content[1].content[0].attrs.x, 200);
  await fs.writeFile(
    markdown,
    (await fs.readFile(markdown, "utf8")).replace("主题", "外部修改导图"),
  );
  const conflict = await api("documents/" + note.id);
  assert.match(conflict.sync_warning, /副本/);
  assert.equal(conflict.snapshot.content[1].content[0].content[0].text, "主题");
  assert.ok((await fs.readdir(path.join(store.root, "conflicts"))).length);
});
test("本地回收站保留正文、批次恢复与彻底删除", async (t) => {
  const { api, note } = await fixture(t);
  await api("documents/" + note.id, "DELETE");
  await api("documents/" + note.id, "GET", undefined, 404);
  const [row] = await api("trash/documents");
  await api(`documents/${note.id}/restore-deleted`, "POST", {});
  await api(
    `trash/documents/${note.id}`,
    "DELETE",
    { deletion_token: row.trash_batch },
    409,
  );
  await api("documents/" + note.id, "DELETE");
  const [next] = await api("trash/documents");
  await api(`trash/documents/${note.id}`, "DELETE", {
    deletion_token: next.trash_batch,
  });
  assert.deepEqual(await api("trash/documents"), []);
});
test("本地附件分块校验、PDF 与 Range 读取", async (t) => {
  const { store, api, note } = await fixture(t),
    bytes = Buffer.from("%PDF-1.4\nlocal document\n%%EOF"),
    task = await api("uploads", "POST", {
      doc_id: note.id,
      filename: "论文.pdf",
      bytes: bytes.length,
      hash: digest(bytes),
    });
  const url = new URL(`anote://app/api/uploads/${task.id}/chunk`),
    response = await store.respond(
      new Request(url, {
        method: "PUT",
        headers: { "Upload-Offset": "0", "X-Chunk-SHA256": digest(bytes) },
        body: bytes,
      }),
      url,
    );
  assert.equal(response.status, 200);
  const asset = await api(`uploads/${task.id}/complete`, "POST", {});
  assert.equal(asset.mime, "application/pdf");
  const file = new URL("anote://app" + asset.url),
    read = await store.respond(
      new Request(file, { headers: { Range: "bytes=0-4" } }),
      file,
    );
  assert.equal(read.status, 206);
  assert.equal(await read.text(), "%PDF-");
});

async function files(directory,prefix=""){
  const result={};for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){const relative=path.join(prefix,entry.name);if(entry.isDirectory())Object.assign(result,await files(directory,relative));else if(entry.isFile())result[relative]=digest(await fs.readFile(path.join(directory,relative)));}return result;
}
const migrationJournal=id=>({format:"anote-personal-directory-migration",version:1,from:".simple-notes",to:".anote",catalogId:id,phase:"prepared"});

test("新目录使用.anote；旧.simple-notes原子迁移保留富文本、附件、历史与Markdown字节",async t=>{
  const {store,directory,api,note,edit}=await fixture(t);assert.equal(path.basename(store.root),".anote");
  const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6s9sAAAAASUVORK5CYII=","base64"),upload=await api("uploads","POST",{doc_id:note.id,filename:"全景.png",bytes:bytes.length,hash:digest(bytes)}),url=new URL(`anote://app/api/uploads/${upload.id}/chunk`);
  assert.equal((await store.respond(new Request(url,{method:"PUT",headers:{"Upload-Offset":"0","X-Chunk-SHA256":digest(bytes)},body:bytes}),url)).status,200);
  const asset=await api(`uploads/${upload.id}/complete`,"POST",{});
  await edit([{type:"paragraph",attrs:{blockId:"rich"},content:[{type:"text",text:"保留粗体与公式",marks:[{type:"bold"}]},{type:"inlineMath",attrs:{latex:"E=mc^2"}}]},{type:"mediaResource",attrs:{blockId:"panorama",assetId:asset.id,src:asset.url,localPath:asset.localPath,title:"全景图片",kind:"image",mime:asset.mime,bytes:asset.bytes,hash:asset.hash,projection:"equirectangular"}}]);
  await api(`documents/${note.id}/versions`,"POST",{label:"迁移前真实历史",version_name:"v1"});
  const prior=await store.record(note.id),catalog=structuredClone(store.index);await store.close();
  const legacy=path.join(directory,".simple-notes");await fs.rename(store.root,legacy);const before=await files(legacy),migrated=await new PersonalStore(directory).load();
  try{
    assert.equal(path.basename(migrated.root),".anote");assert.equal(await fs.stat(legacy).catch(()=>null),null);assert.deepEqual(migrated.index,catalog);assert.deepEqual(await migrated.record(note.id),prior);
    const after=await files(migrated.root);for(const [file,checksum] of Object.entries(before))assert.equal(after[file],checksum,file);
    assert.equal((await migrated.record(note.id)).snapshot.content[1].attrs.projection,"equirectangular");assert.equal((await migrated.record(note.id)).versions[0].version_name,"v1");
    const file=new URL("anote://app"+asset.url),response=await migrated.respond(new Request(file),file);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    assert.equal(await fs.stat(path.join(directory,".anote-migration.json")).catch(()=>null),null);assert.equal(await fs.stat(path.join(directory,".anote-directory.lock")).catch(()=>null),null);
    assert.equal(JSON.parse(await fs.readFile(path.join(migrated.root,".migration.json"),"utf8")).phase,"complete");
  }finally{await migrated.close();}
});

test("活动旧客户端锁阻止迁移，两个有内容的目录不会被合并或覆盖",async t=>{
  const {store,directory}=await fixture(t);await store.close();const legacy=path.join(directory,".simple-notes");await fs.rename(store.root,legacy);
  const lock=path.join(legacy,"lock.json"),token=randomUUID();await fs.writeFile(lock,JSON.stringify({pid:process.pid,token}));const before=await files(legacy);
  await assert.rejects(()=>new PersonalStore(directory).load(),/另一客户端/);assert.deepEqual(await files(legacy),before);assert.equal(await fs.stat(path.join(directory,".anote")).catch(()=>null),null);
  await fs.unlink(lock);await fs.mkdir(path.join(directory,".anote"));await fs.writeFile(path.join(directory,".anote","other-data.json"),"不要覆盖");
  await assert.rejects(()=>new PersonalStore(directory).load(),/均有内容/);assert.equal(await fs.readFile(path.join(directory,".anote","other-data.json"),"utf8"),"不要覆盖");assert.equal((await files(legacy))["catalog.json"],before["catalog.json"]);
});

for(const committed of [false,true])test(`迁移中断恢复：${committed?"目录已改名但未提交完成标记":"prepared后尚未改名"}保留原稿`,async t=>{
  const {store,directory,note}=await fixture(t),prior=await store.record(note.id),identity=store.index.id;await store.close();
  const folder=committed?store.root:path.join(directory,".simple-notes");if(!committed)await fs.rename(store.root,folder);
  await fs.writeFile(path.join(directory,".anote-migration.json"),JSON.stringify(migrationJournal(identity)));await fs.writeFile(path.join(folder,"lock.json"),JSON.stringify({pid:2147483647,token:randomUUID()}));
  const recovered=await new PersonalStore(directory).load();try{assert.deepEqual(await recovered.record(note.id),prior);assert.equal(path.basename(recovered.root),".anote");assert.equal(await fs.stat(path.join(directory,".anote-migration.json")).catch(()=>null),null);}finally{await recovered.close();}
});

test("迁移拒绝目录和内部文件软链接，不读取或改写目录外文件",async t=>{
  const {store,directory}=await fixture(t);await store.close();const legacy=path.join(directory,".simple-notes"),outside=path.join(directory,"outside.json");await fs.rename(store.root,legacy);await fs.writeFile(outside,"目录外原件");await fs.symlink(outside,path.join(legacy,"assets","escape"));
  await assert.rejects(()=>new PersonalStore(directory).load(),/符号链接/);assert.equal(await fs.readFile(outside,"utf8"),"目录外原件");assert.equal(await fs.stat(store.root).catch(()=>null),null);
  await fs.unlink(path.join(legacy,"assets","escape"));await fs.symlink(legacy,store.root,"dir");await assert.rejects(()=>new PersonalStore(directory).load(),/符号链接/);assert.equal(await fs.readFile(outside,"utf8"),"目录外原件");await fs.unlink(store.root);
});

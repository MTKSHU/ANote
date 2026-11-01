import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as Y from "yjs";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { schema } from "@anote/document-model";
import { PersonalStore } from "../../apps/desktop/main/personal-store.mjs";
import { createHash } from "node:crypto";
const digest = (data) => createHash("sha256").update(data).digest("hex");
async function fixture(t) {
  const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "anote-personal-"),
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

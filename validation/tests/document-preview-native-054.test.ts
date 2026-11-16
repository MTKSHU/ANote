import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import {OfflineStore} from '../../apps/desktop/main/offline-store.mjs';
import {historyHeavyTodo052} from '../fixtures/history-heavy-todo-052';
import {runDocumentWorker} from '../../apps/desktop/main/document-worker-runner.mjs';

test('native cold previews avoid full state parsing and repair stale derived sidecars in a worker',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-preview-054-')),fixture=historyHeavyTodo052(),opened:any[]=[];
  t.after(async()=>{for(const store of opened)await store.close();fixture.document.destroy();await fs.rm(directory,{recursive:true,force:true});});
  const session={profileRoot:directory,settings:{serverURL:'https://preview.example.test',user:{id:'owner'},offline:true},token:null};
  const first=await new OfflineStore(session).load();opened.push(first);
  await first.cacheDocument({id:'note',ystate:Buffer.from(fixture.update).toString('base64'),metadata:{id:'note',space_id:'book',title:'离线未提交草稿',role:'admin'}});await first.close();
  const file=path.join(first.root,'documents/note.json'),saved=JSON.parse(await fs.readFile(file,'utf8')),readFile=fs.readFile;
  const guard=t.mock.method(fs,'readFile',async(input:any,...args:any[])=>{assert.notEqual(String(input),file,'the Electron main thread must not read the full state for preview/cold metadata');return (readFile as any)(input,...args);});
  const second=await new OfflineStore(session).load();opened.push(second);assert.equal(second.status().pending,1);assert.equal(second.data.documents.note.ystate,undefined);assert.equal(second.data.documents.note.snapshot,undefined);
  const url=new URL('anote://app/api/documents/note/preview'),preview=await (await second.read(new Request(url),url)).json();assert.equal(preview.preview_source,'local-draft');assert.deepEqual(preview.snapshot,saved.snapshot);assert.equal(preview.ystate,undefined);
  await second.close();guard.mock.restore();
  // Simulate the older client rewriting the canonical v2 record without
  // knowing about optional summaries, then force their regeneration.
  const paragraph=((fixture.document.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  (paragraph.get(0) as Y.XmlText).insert(0,'旧客户端最后保存');
  const {initProseMirrorDoc}=await import('@tiptap/y-tiptap'),{schema}=await import('@anote/document-model');
  saved.ystate=Buffer.from(Y.encodeStateAsUpdate(fixture.document)).toString('base64');saved.snapshot=JSON.parse(JSON.stringify(initProseMirrorDoc(fixture.document.getXmlFragment('default'),schema).doc.toJSON()));saved.pending.revision++;
  await fs.writeFile(file,JSON.stringify(saved));
  const guardAgain=t.mock.method(fs,'readFile',async(input:any,...args:any[])=>{assert.notEqual(String(input),file);return (readFile as any)(input,...args);});
  const third=await new OfflineStore(session).load();opened.push(third);const repaired=await third.previewRecord('note');assert.deepEqual(repaired.snapshot,saved.snapshot);assert.equal(repaired.local_revision,saved.pending.revision);assert.equal(third.data.documents.note.ystate,undefined);guardAgain.mock.restore();
});

test('a mixed old/new cache upgrades in one worker and retains index order and pending titles',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-mixed-preview-054-')),root=path.join(directory,'offline'),identity={serverURL:'https://mixed.example.test',userId:'owner'},session={profileRoot:directory,settings:{...identity,user:{id:'owner'},offline:true},token:null};
  const {prosemirrorJSONToYDoc}=await import('@tiptap/y-tiptap'),{schema}=await import('@anote/document-model');
  const document=prosemirrorJSONToYDoc(schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:'body'},content:[{type:'text',text:'待同步正文'}]}]},'default');let store:any;
  t.after(async()=>{await store?.close();document.destroy();await fs.rm(directory,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'documents'),{recursive:true});const keys=['old-first','cached-second'];
  await fs.writeFile(path.join(root,'index.json'),JSON.stringify({format:2,identity,documents:keys}));
  for(const key of keys)await fs.writeFile(path.join(root,`documents/${key}.json`),JSON.stringify({metadata:{id:key,title:key,role:'admin'},snapshot:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'body'},content:[{type:'text',text:'待同步正文'}]}]},ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'),assets:[],pending:{opId:key,revision:3,title:'保留 '+key}}));
  await runDocumentWorker({operation:'inspect',sourceRoot:root,identity,id:'cached-second'});
  const readFile=fs.readFile,guard=t.mock.method(fs,'readFile',async(input:any,...args:any[])=>{assert(!keys.some(key=>String(input)===path.join(root,`documents/${key}.json`)));return (readFile as any)(input,...args);});
  store=await new OfflineStore(session).load();assert.deepEqual(Object.keys(store.data.documents),keys);assert.equal(store.status().pending,2);for(const key of keys){assert.equal(store.pendingTitle(key),'保留 '+key);assert.equal(store.data.documents[key].ystate,undefined);assert.equal((await store.previewRecord(key)).snapshot.content[0].content[0].text,'待同步正文');}guard.mock.restore();
});

import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {PersonalStore} from '../../apps/desktop/main/personal-store.mjs';
import {LocalMcp} from '../../apps/desktop/main/local-mcp.mjs';
import {acquireLibraryActivity,acquireLibraryTransition} from '../../apps/api/src/library-activity.ts';

test('archive gate drains accepted edits, leaves other libraries concurrent and releases safely',async()=>{
 const id=randomUUID(),events:string[]=[],one=await acquireLibraryActivity(id),two=await acquireLibraryActivity(id);
 const archive=acquireLibraryTransition(id).then(release=>{events.push('archive');return release;});
 const reader=acquireLibraryActivity(id).then(release=>{events.push('reader');return release;});
 const other=await acquireLibraryActivity('other');other();one();await Promise.resolve();assert.deepEqual(events,[]);two();
 const release=await archive;assert.deepEqual(events,['archive']);release();release();const after=await reader;assert.deepEqual(events,['archive','reader']);after();
 const again=await acquireLibraryTransition(id);again();
});

test('local archive changes only the catalog, blocks pending MCP writes, keeps Markdown edits and survives restart',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-archive-'));let store:any;
 const api=async(route:string,method='GET',body?:any,status=200)=>{const url=new URL('/api/'+route,'http://local'),r=await store.respond(new Request(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),url);const value=await r.json();assert.equal(r.status,status,value.error);return value;};
 try{
  store=await new PersonalStore(directory).load();const book=await api('spaces','POST',{kind:'personal',name:'归档本地库'}),note=await api('documents','POST',{space_id:book.id,title:'原始笔记'}),already=await api('documents','POST',{space_id:book.id,title:'原已归档'});
  await api('documents/'+already.id,'PATCH',{archived:true});
  const document=prosemirrorJSONToYDoc(schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'Local original'}]}]},'default');try{await api('documents/'+note.id+'/local-state','PUT',{ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')});}finally{document.destroy();}
  const mcp=new LocalMcp({getStore:()=>store}),before=await mcp.call(store,'read_note',{note_id:note.id});
  const prepared=await mcp.call(store,'prepare_changes',{note_id:note.id,base_hash:before.base_hash,schema_version:EDITOR_SCHEMA_VERSION,title:'blocked',operations:[]});
  const recordFile=await store.safe('notes/'+note.id+'.json'),bytes=await fs.readFile(recordFile),markdown=await fs.readFile(await store.safe('markdown/'+note.id+'.md'),'utf8');
  const legacyAsset=randomUUID();store.index.assets.push({id:legacyAsset,doc_id:note.id,filename:'legacy.txt',mime:'text/plain'});
  await api(`spaces/${book.id}/archive`,'PATCH',{archived:true,revision:0});assert.equal(store.index.version,2);await api('assets/'+legacyAsset,'PATCH',{title:'blocked'},409);assert.deepEqual(await fs.readFile(recordFile),bytes);
  for(const [route,method,body] of [['documents','POST',{space_id:book.id,title:'blocked'}],['documents/'+note.id,'PATCH',{title:'blocked'}],[`spaces/${book.id}/folders`,'POST',{name:'blocked'}]] as const)await api(route,method,body,409);
  await assert.rejects(()=>mcp.call(store,'apply_changes',{change_id:prepared.change_id,preview_hash:prepared.preview_hash,operation_id:randomUUID()}),/归档知识库|知识库已归档/);
  assert.equal((await api('documents/'+note.id)).library_archived,true);assert.equal((await api('documents/'+note.id)).role,'viewer');assert.equal((await api('documents/'+already.id)).archived,true);
  const edited=markdown.replace('Local original','External kept');await fs.writeFile(await store.safe('markdown/'+note.id+'.md'),edited);await api('documents/'+note.id);assert.deepEqual(await fs.readFile(recordFile),bytes);assert.equal(await fs.readFile(await store.safe('markdown/'+note.id+'.md'),'utf8'),edited);
  await store.close();store=await new PersonalStore(directory).load();assert.equal((await api('spaces')).find((item:any)=>item.id===book.id).archived,true);
  await api(`spaces/${book.id}/archive`,'PATCH',{archived:false,revision:0},409);await api(`spaces/${book.id}/archive`,'PATCH',{archived:false,revision:1});assert.equal((await api('documents/'+already.id)).archived,true);await api('documents/'+note.id,'PATCH',{title:'恢复后的笔记'});
 }finally{await store?.close();await fs.rm(directory,{recursive:true,force:true});}
});

import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {PersonalStore} from '../../apps/desktop/main/personal-store.mjs';
import {LocalMcp} from '../../apps/desktop/main/local-mcp.mjs';

async function status(endpoint,token){return new Promise((resolve,reject)=>{const req=http.request(endpoint,{method:'POST',agent:false,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function api(store,route,method='GET',body){const url=new URL('/api/'+route,'http://local');const response=await store.respond(new Request(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),url);assert(response.ok,await response.clone().text());return response.json();}
async function connect(endpoint,token){const client=new Client({name:'local-isolated-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return client;}
async function call(client,name,args={},status){const result=await client.callTool({name,arguments:args});if(status){assert(result.isError);const value=JSON.parse(result.content[0].text);assert.equal(value.status,status,value.error);return value;}assert(!result.isError,result.content[0]?.text);return result.structuredContent;}

test('real local MCP authenticates, previews, preserves edits/history, rejects stale writes and isolates directories',async()=>{
  assert.equal(process.env.ANOTE_ISOLATED_TESTS,'1');const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-local-mcp-056-'));let store,other,current,mcp,client,restarted;
  try{
    await fs.mkdir(path.join(directory,'first'));await fs.mkdir(path.join(directory,'second'));store=await new PersonalStore(path.join(directory,'first')).load();current=store;
    const book=await api(store,'spaces','POST',{name:'Local MCP test',kind:'personal'}),port=await freePort();let flushes=0,changed=0;
    mcp=new LocalMcp({getStore:()=>current,beforeAccess:async()=>{flushes++;},onChanged:()=>changed++,defaultPort:port});await mcp.sync();assert.equal(mcp.state().running,false);
    const configured=await mcp.configure({enabled:true});assert(configured.endpoint.startsWith('http://127.0.0.1:'));assert(configured.token);assert.equal(mcp.server.address().address,'127.0.0.1');
    const persisted=await fs.readFile(await store.safe('mcp.json'),'utf8');assert(!persisted.includes(configured.token));assert.equal((await fs.stat(await store.safe('mcp.json'))).mode&0o777,0o600);
    for(const headers of [{},{Authorization:'Bearer wrong'}])assert.equal((await fetch(configured.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'})).status,401);
    assert.equal((await fetch(configured.endpoint,{method:'POST',headers:{Authorization:'Bearer '+configured.token,Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal(await new Promise((resolve,reject)=>{const req=http.request(configured.endpoint,{method:'POST',headers:{Authorization:'Bearer '+configured.token,Host:'evil.example','Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');}),403);
    client=await connect(configured.endpoint,configured.token);assert((await client.listTools()).tools.some(t=>t.name==='prepare_changes'));assert.equal((await call(client,'get_editor_rules')).schema_version,EDITOR_SCHEMA_VERSION);
    const proposal=await call(client,'prepare_changes',{library_id:book.id,title:'本地 AI 新建',schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'insert',node:{type:'paragraph',attrs:{firstLineIndent:2},content:[{type:'text',text:'原始正文'}]}}]});
    assert.equal(store.index.documents.length,0,'prepare must not create a note');
    const apply={change_id:proposal.change_id,preview_hash:proposal.preview_hash,operation_id:randomUUID()},created=await call(client,'apply_changes',apply);assert.equal(changed,1);
    assert.deepEqual(await call(client,'apply_changes',apply),created);assert.equal(changed,1,'same operation must not apply twice');
    const committed=await store.record(created.doc_id),revision=store.note(created.doc_id).revision;await api(store,'documents/'+created.doc_id+'/local-state','PUT',{ystate:committed.ystate});assert.equal(store.note(created.doc_id).revision,revision,'an already saved local MCP state must not save twice');
    let read=await call(client,'read_note',{note_id:created.doc_id});assert.equal(read.blocks[0].content[0].text,'原始正文');assert.equal(read.blocks[0].attrs.firstLineIndent,2);assert(!Object.hasOwn(read,'snapshot'));assert.equal((await call(client,'list_notes',{query:'原始正文'})).total,1);
    const replace=structuredClone(read.blocks[0]);replace.content[0].text='MCP 修改正文';
    const stale=await call(client,'prepare_changes',{note_id:created.doc_id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'replace',block_id:replace.attrs.blockId,node:replace}]});
    await api(store,'documents/'+created.doc_id,'PATCH',{title:'用户刚修改标题'});await call(client,'apply_changes',{change_id:stale.change_id,preview_hash:stale.preview_hash,operation_id:randomUUID()},409);
    read=await call(client,'read_note',{note_id:created.doc_id});const edit=await call(client,'prepare_changes',{note_id:created.doc_id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'replace',block_id:replace.attrs.blockId,node:replace}]});
    await call(client,'apply_changes',{change_id:edit.change_id,preview_hash:edit.preview_hash,operation_id:randomUUID()});
    const versions=await api(store,'documents/'+created.doc_id+'/versions');assert(versions.some(v=>v.source==='before-integration'));assert(versions.some(v=>v.source==='integration'));assert.equal((await call(client,'read_note',{note_id:created.doc_id})).blocks[0].attrs.blockId,read.blocks[0].attrs.blockId);
    const assetId=randomUUID();store.index.assets.push({id:assetId,space_id:book.id,filename:'sample.txt',mime:'text/plain',kind:'file',bytes:11});await store.write('assets/'+assetId,'known asset');assert.equal((await call(client,'read_asset',{asset_id:assetId})).text,'known asset');assert.equal((await call(client,'search_assets',{note_id:created.doc_id,query:'sample'})).total,1);
    const hiddenId=randomUUID(),outside=path.join(directory,'private.txt');await fs.writeFile(outside,'not an attachment');store.index.assets.push({id:hiddenId,space_id:book.id,filename:'forged.txt',mime:'text/plain',kind:'file',bytes:17});await fs.symlink(outside,await store.safe('assets/'+hiddenId));await call(client,'read_asset',{asset_id:hiddenId},400);
    await call(client,'read_note',{note_id:'../../etc/passwd'},400);
    await call(client,'prepare_changes',{note_id:created.doc_id,base_hash:read.base_hash,schema_version:7,operations:[]},409);assert(flushes>0);
    await client.close();client=null;await mcp.stop();restarted=new LocalMcp({getStore:()=>current});await restarted.sync();client=await connect(restarted.state().endpoint,configured.token);assert.equal((await call(client,'read_note',{note_id:created.doc_id})).blocks[0].content[0].text,'MCP 修改正文');assert.deepEqual(await call(client,'apply_changes',apply),created);
    await client.close();client=null;const rotated=await restarted.configure({rotate:true});assert(rotated.token!==configured.token);assert.equal(await status(rotated.endpoint,configured.token),401);
    other=await new PersonalStore(path.join(directory,'second')).load();current=other;assert.equal(await status(rotated.endpoint,rotated.token),409);await restarted.sync();assert.equal(restarted.state().enabled,false);assert.equal(restarted.state().running,false);
  }finally{await client?.close().catch(()=>{});await mcp?.stop();await restarted?.stop();await store?.close();await other?.close();await fs.rm(directory,{recursive:true,force:true});}
});

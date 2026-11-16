import {test,expect,request as playwrightRequest,type APIRequestContext} from '@playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import * as Y from 'yjs';
import {EDITOR_SCHEMA_VERSION,schema,canonical} from '@anote/document-model';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {scanDocumentMigrationEncoding} from '@anote/document-model/migration-codec';
import {api,admin} from './helpers';
import {fixture,register,authorization,connect,call} from './mcp-helpers';

// The QA browser reaches an internal network alias while OAuth's resource
// remains the configured public issuer. Bind both phases to that exact issuer.
async function grantForIssuer(account:any,issuer:string){
  const context=await playwrightRequest.newContext({baseURL:process.env.BASE_URL||'http://anote.internal:3000'});
  try{
    const client=await register(context,'MCP encoding055 '+randomUUID()),flow=authorization(client),url=new URL(flow.url);url.searchParams.set('resource',issuer+'/mcp');
    const start=await context.get(url.href,{maxRedirects:0});expect(start.status(),await start.text()).toBe(303);const id=new URL(start.headers().location).searchParams.get('mcp_authorize')!;
    await api(context,'GET','me/integrations/authorization/'+id,undefined,account);
    const decision=await api(context,'POST','me/integrations/authorization/'+id,{allow:true},account),callback=new URL(decision.redirect_uri);expect(callback.searchParams.get('state')).toBe(flow.state);
    const response=await context.post('/token',{form:{grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code')!,code_verifier:flow.verifier,redirect_uri:client.redirect_uris[0],resource:issuer+'/mcp'}});expect(response.status(),await response.text()).toBe(200);
    return {tokens:await response.json(),client,close:()=>context.dispose()};
  }catch(error){await context.dispose();throw error;}
}

async function requireIsolatedQA(request:APIRequestContext){
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');
  const issuer=process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3200',base=new URL(process.env.BASE_URL||'http://anote.internal:3000');
  expect(['http://127.0.0.1:3200','http://127.0.0.1:3210','http://127.0.0.1:3220']).toContain(issuer);expect(base.origin).toBe('http://anote.internal:3000');
  expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe(issuer);expect(process.env.DB_PASSWORD).toBeTruthy();
  return issuer;
}

test('MCP keeps its authenticated JSON read/create/edit contract on activated encoding2 notes',async({request})=>{
  const issuer=await requireIsolatedQA(request);
  const db=new Pool({host:'db',database:'anote',user:'anote',password:process.env.DB_PASSWORD,application_name:'anote-mcp-encoding-055-isolated-test'});
  let access:any,peerAccess:any,client:any,peerClient:any;
  try{
    expect((await db.query('SELECT default_encoding FROM document_state_settings WHERE singleton')).rows[0].default_encoding).toBe(2);
    const {owner,peer,book,note}=await fixture(request);access=await grantForIssuer(owner,issuer);client=await connect(access.tokens.access_token);
    const ordinary=(await db.query('SELECT state_encoding FROM documents WHERE id=$1',[note.id])).rows[0];expect(ordinary.state_encoding).toBe(2);
    const initial=await call(client,'read_note',{note_id:note.id});expect(initial.title).toBe(note.title);expect(initial.schema_version).toBe(EDITOR_SCHEMA_VERSION);
    const proposal=await call(client,'prepare_changes',{library_id:book.id,title:'MCP 编码2创建 '+randomUUID(),schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'insert',node:{type:'paragraph',content:[{type:'text',text:'JSON 工具无需携带二进制编码标识'}]}}]});
    const created=await call(client,'apply_changes',{change_id:proposal.change_id,preview_hash:proposal.preview_hash,operation_id:randomUUID()});
    let read=await call(client,'read_note',{note_id:created.doc_id});expect(read.blocks[0].content[0].text).toBe('JSON 工具无需携带二进制编码标识');
    const stale=await call(client,'prepare_changes',{note_id:created.doc_id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,title:'旧预览不得覆盖',operations:[]});
    const changed=structuredClone(read.blocks[0]);changed.content[0].text+='，同一令牌继续修改';
    const edit=await call(client,'prepare_changes',{note_id:created.doc_id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'replace',block_id:changed.attrs.blockId,node:changed}]});
    await call(client,'apply_changes',{change_id:edit.change_id,preview_hash:edit.preview_hash,operation_id:randomUUID()});
    await call(client,'apply_changes',{change_id:stale.change_id,preview_hash:stale.preview_hash,operation_id:randomUUID()},409);
    read=await call(client,'read_note',{note_id:created.doc_id});expect(read.blocks[0].content[0].text).toContain('同一令牌继续修改');
    expect(JSON.stringify(read)).not.toContain('__anote_sync_meta');expect((await client.listTools()).tools.some((tool:any)=>tool.name==='read_note')).toBe(true);
    const stored=(await db.query('SELECT state_encoding,ystate FROM documents WHERE id=$1',[created.doc_id])).rows[0],document=new Y.Doc();try{Y.applyUpdate(document,stored.ystate);expect(stored.state_encoding).toBe(2);expect(scanDocumentMigrationEncoding(document)).toBe(2);}finally{document.destroy();}
    peerAccess=await grantForIssuer(peer,issuer);peerClient=await connect(peerAccess.tokens.access_token);await call(peerClient,'read_note',{note_id:created.doc_id},403);
    const versions=await api(request,'GET',`documents/${created.doc_id}/versions`,undefined,owner);expect(versions.some((version:any)=>version.source==='integration')).toBe(true);
  }finally{await client?.close();await peerClient?.close();await access?.close();await peerAccess?.close();await db.end();}
});

test('an existing MCP OAuth token and prepared JSON edit survive a real encoding1 to encoding2 conversion',async({request},testInfo)=>{
  const issuer=await requireIsolatedQA(request),db=new Pool({host:'db',database:'anote',user:'anote',password:process.env.DB_PASSWORD,application_name:'anote-mcp-existing-auth-conversion-055'});
  let access:any,client:any;
  try{
    const owner=await admin(request),book=await api(request,'POST','spaces',{kind:'personal',name:'MCP 既有认证迁移 '+randomUUID()},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'MCP 认证穿越编码转换 '+randomUUID()},owner);
    const snapshot=canonical({type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'令牌在旧编码时取得'}]}]}),seed=prosemirrorJSONToYDoc(schema,snapshot,'default');
    try{
      seed.getMap('__tiptap_position_migrations:root:default').set('legacy:1',{version:1,client:2147483646,clock:1,seen:[],transfers:[{source:{client:2147483645,clock:1000,length:1},target:{client:2147483644,clock:2000,type:{client:2147483644,clock:0},assoc:0}}]});
      const injected=await db.query('UPDATE documents SET ystate=$1,snapshot=$2,state_encoding=1 WHERE id=$3 AND space_id=$4 AND created_by=$5 AND title=$6 RETURNING id',[Buffer.from(Y.encodeStateAsUpdate(seed)),snapshot,note.id,book.id,owner.user.id,note.title]);expect(injected.rowCount).toBe(1);
    }finally{seed.destroy();}
    access=await grantForIssuer(owner,issuer);client=await connect(access.tokens.access_token);
    const tokenHash=createHash('sha256').update(access.tokens.access_token).digest('hex'),tokenBefore=(await db.query("SELECT grant_id FROM mcp_tokens WHERE hash=$1 AND kind='access'",[tokenHash])).rows[0];expect(tokenBefore).toBeTruthy();
    const before=await call(client,'read_note',{note_id:note.id}),changed=structuredClone(before.blocks[0]);changed.content[0].text+='，同一认证在转换后写入';
    const preparedBeforeConversion=await call(client,'prepare_changes',{note_id:note.id,base_hash:before.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'replace',block_id:changed.attrs.blockId,node:changed}]});
    expect((await db.query('SELECT state_encoding FROM documents WHERE id=$1',[note.id])).rows[0].state_encoding).toBe(1);
    let applied:any,attempts=0;
    for(;attempts<20;attempts++){
      const preview=await api(request,'POST',`documents/${note.id}/state-maintenance/preview`,{},owner);expect(preview.sourceEncoding).toBe(1);
      const result=await api(request,'POST',`documents/${note.id}/state-maintenance/apply`,{confirm:true,sourceStateRevision:preview.sourceStateRevision},owner);
      if(result.applied){applied=result;break;}
      expect(result.reason).toBe('document-active');await new Promise(resolve=>setTimeout(resolve,100));
    }
    expect(applied?.applied,'Real Hocuspocus maps must report this disconnected note idle').toBe(true);
    expect((await call(client,'read_note',{note_id:note.id})).base_hash).toBe(before.base_hash);
    await call(client,'apply_changes',{change_id:preparedBeforeConversion.change_id,preview_hash:preparedBeforeConversion.preview_hash,operation_id:randomUUID()});
    const after=await call(client,'read_note',{note_id:note.id});expect(after.blocks[0].content[0].text).toContain('同一认证在转换后写入');
    const tokenAfter=(await db.query("SELECT grant_id FROM mcp_tokens WHERE hash=$1 AND kind='access' AND consumed_at IS NULL",[tokenHash])).rows[0];expect(tokenAfter?.grant_id).toBe(tokenBefore.grant_id);
    expect((await db.query('SELECT count(*)::int AS n FROM mcp_grants WHERE user_id=$1 AND client_id=$2',[owner.user.id,access.client.client_id])).rows[0].n).toBe(1);
    const stored=(await db.query('SELECT state_encoding,ystate FROM documents WHERE id=$1',[note.id])).rows[0],document=new Y.Doc();try{Y.applyUpdate(document,stored.ystate);expect(stored.state_encoding).toBe(2);expect(scanDocumentMigrationEncoding(document)).toBe(2);expect(document.getMap('__tiptap_position_migrations:root:default').get('legacy:1')).toBeInstanceOf(Uint8Array);}finally{document.destroy();}
    await testInfo.attach('mcp-existing-token-across-conversion.json',{body:JSON.stringify({encodingBefore:1,encodingAfter:2,sameOAuthGrant:true,newGrantCount:0,bodyHashStableAcrossProtocolChange:true,preparedBeforeConversionAppliedAfter:true,maintenanceAttempts:attempts+1}),contentType:'application/json'});
  }finally{await client?.close();await access?.close();await db.end();}
});

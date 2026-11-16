import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {test,expect,request as contexts} from '@playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {api,admin,login} from './helpers';
import {connect,call,upload,person} from './mcp-helpers';

async function isolated(request:any){
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');
  expect((await request.get('/api/platform/public').then((r:any)=>r.json())).public_origin).toBe(process.env.QA_PUBLIC_ORIGIN||'http://127.0.0.1:3240');
}
const archive=(request:any,owner:any,id:string,archived:boolean,revision?:number|string)=>api(request,'PATCH',`spaces/${id}/archive`,{archived,...(revision!==undefined?{revision}:{})},owner);

test('library archive preserves data, original note flags and shares while enforcing every writer and the same MCP token',async({request},info)=>{
  test.skip(info.project.name!=='desktop');await isolated(request);
  const owner=await person(request),peer=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'归档资料 '+randomUUID()},owner);
  const note=await api(request,'POST','documents',{space_id:book.id,title:'归档保真 '+randomUUID()},owner),already=await api(request,'POST','documents',{space_id:book.id,title:'原先单篇归档'},owner);
  await api(request,'PATCH',`documents/${already.id}`,{archived:true},owner);
  await api(request,'POST',`spaces/${book.id}/sharing/members`,{identity:peer.username},owner);
  const external=await api(request,'POST',`spaces/${book.id}/sharing/links`,{days:7},owner);
  const token=await api(request,'POST','me/integrations/tokens',{name:'Archive compatibility',scopes:['notes:read','notes:write','assets:read','assets:write']},owner);
  const mcp=await connect(token.token);const db=new Pool({host:'db',database:'anote',user:'anote',password:process.env.DB_PASSWORD});
  try{
    const toolsBefore=await mcp.listTools();
    const bytes=Buffer.from('original attachment retained while archived'),hash=createHash('sha256').update(bytes).digest('hex');
    const start=await call(mcp,'begin_upload',{note_id:note.id,filename:'archive-proof.txt',bytes:bytes.length,sha256:hash});
    const transfer=new URL(start.upload_url),sent=await request.put(transfer.pathname+transfer.search,{headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0','Upload-Sha256':hash},data:bytes});expect(sent.status(),await sent.text()).toBe(200);
    const asset=await call(mcp,'complete_upload',{upload_id:start.upload_id});expect(asset.status).toBe('ready');
    const read=await call(mcp,'read_note',{note_id:note.id});
    const proposal=await call(mcp,'prepare_changes',{note_id:note.id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'insert',node:{type:'paragraph',content:[{type:'text',text:'永久保留的正文'}]}},{action:'insert',node:{type:'mediaResource',attrs:{assetId:asset.upload_id||asset.id}}}]});
    await call(mcp,'apply_changes',{change_id:proposal.change_id,preview_hash:proposal.preview_hash,operation_id:randomUUID()});
    const current=await call(mcp,'read_note',{note_id:note.id}),pending=await call(mcp,'prepare_changes',{note_id:note.id,base_hash:current.base_hash,schema_version:EDITOR_SCHEMA_VERSION,title:'不应提交的旧预览',operations:[]});
    const before=(await db.query("SELECT id,encode(ystate,'hex') AS state,snapshot,revision,updated_at,archived FROM documents WHERE space_id=$1 ORDER BY id",[book.id])).rows;
    const versions=(await db.query('SELECT count(*)::int AS n FROM document_versions WHERE doc_id=ANY($1::text[])',[[note.id,already.id]])).rows[0].n;
    await api(request,'PATCH',`spaces/${book.id}/archive`,{archived:true},peer,403);
    const frozen=await archive(request,owner,book.id,true,0);expect(frozen.archived).toBe(true);expect(String(frozen.archive_revision)).toBe('1');expect(String((await archive(request,owner,book.id,true,0)).archive_revision)).toBe('1');
    expect((await api(request,'GET',`documents/${note.id}?content=metadata`,undefined,owner)).role).toBe('viewer');
    expect((await api(request,'GET',`documents/${note.id}?content=metadata`,undefined,peer)).library_archived).toBe(true);
    const actualAsset=current.blocks.find((block:any)=>block.type==='mediaResource').attrs.assetId;
    const original=await request.get('/api/assets/'+actualAsset+'/file',{headers:{Authorization:'Bearer '+owner.token}});expect(original.status()).toBe(200);expect(await original.body()).toEqual(bytes);
    const exported=await api(request,'GET',`documents/${note.id}/export`,undefined,owner);expect(exported.markdown).toContain('永久保留的正文');expect(exported.assets).toHaveLength(1);
    expect((await request.get(external.path.replace('/share/library/','/api/public/libraries/'))).status()).toBe(200);
    const inventory=await api(request,'GET','offline/inventory',undefined,owner);expect(inventory.libraries.find((b:any)=>b.id===book.id)).toMatchObject({archived:true,can_create:false});expect(inventory.documents.find((n:any)=>n.id===note.id)).toMatchObject({library_archived:true,role:'viewer',can_edit:false});
    for(const [method,path,body]of [
      ['POST','documents',{space_id:book.id,title:'blocked'}],['PATCH',`documents/${note.id}`,{title:'blocked'}],['DELETE',`documents/${note.id}`,undefined],
      ['POST',`documents/${note.id}/comments`,{body:'blocked'}],['POST',`spaces/${book.id}/folders`,{name:'blocked'}],['PATCH',`spaces/${book.id}`,{name:'blocked'}],
    ] as const)await api(request,method,path,body,owner,409);
    await call(mcp,'prepare_changes',{library_id:book.id,title:'blocked',schema_version:EDITOR_SCHEMA_VERSION,operations:[]},409);
    await call(mcp,'apply_changes',{change_id:pending.change_id,preview_hash:pending.preview_hash,operation_id:randomUUID()},409);
    await call(mcp,'begin_upload',{note_id:note.id,filename:'blocked.txt',bytes:1,sha256:createHash('sha256').update('x').digest('hex')},409);
    const after=(await db.query("SELECT id,encode(ystate,'hex') AS state,snapshot,revision,updated_at,archived FROM documents WHERE space_id=$1 ORDER BY id",[book.id])).rows;expect(after).toEqual(before);
    expect((await db.query('SELECT count(*)::int AS n FROM document_versions WHERE doc_id=ANY($1::text[])',[[note.id,already.id]])).rows[0].n).toBe(versions);
    expect(await mcp.listTools()).toEqual(toolsBefore);expect((await call(mcp,'read_note',{note_id:note.id})).library_archived).toBe(true);
    await api(request,'PATCH',`spaces/${book.id}/archive`,{archived:false,revision:0},owner,409);
    await archive(request,owner,book.id,false,1);
    expect((await api(request,'GET',`documents/${note.id}?content=metadata`,undefined,owner)).role).toBe('admin');expect((await api(request,'GET',`documents/${already.id}?content=metadata`,undefined,owner)).archived).toBe(true);
    const restored=await call(mcp,'read_note',{note_id:note.id});const edit=await call(mcp,'prepare_changes',{note_id:note.id,base_hash:restored.base_hash,schema_version:EDITOR_SCHEMA_VERSION,title:'同一 MCP 令牌恢复编辑',operations:[]});await call(mcp,'apply_changes',{change_id:edit.change_id,preview_hash:edit.preview_hash,operation_id:randomUUID()});
    const team=await api(request,'POST','teams',{name:'归档团队 '+randomUUID()},owner),teamBook=await api(request,'POST','spaces',{kind:'team',team_id:team.id,name:'团队库'},owner);
    await api(request,'POST',`spaces/${teamBook.id}/members`,{user_id:peer.user.id,role:'editor'},owner);
    await api(request,'PATCH',`spaces/${teamBook.id}/archive`,{archived:true},peer,403);await archive(request,owner,teamBook.id,true);await archive(request,owner,teamBook.id,false);
  }finally{await mcp.close();await db.end();}
});

test('archive waits for an admitted database write and rejects later content writes',async({request},info)=>{
  test.skip(info.project.name!=='desktop');await isolated(request);
  const owner=await admin(request),book=await api(request,'POST','spaces',{kind:'personal',name:'事务归档 '+randomUUID()},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'before'},owner);
  const db=new Pool({host:'db',database:'anote',user:'anote',password:process.env.DB_PASSWORD}),writer=await db.connect();
  try{
    await writer.query('BEGIN');await writer.query("UPDATE documents SET title='accepted before archive' WHERE id=$1",[note.id]);
    let settled=false;const transition=archive(request,owner,book.id,true).finally(()=>settled=true);await new Promise(resolve=>setTimeout(resolve,150));expect(settled).toBe(false);
    await writer.query('COMMIT');await transition;
    await expect(db.query("UPDATE documents SET title='too late' WHERE id=$1",[note.id])).rejects.toMatchObject({code:'PZA01'});
    expect((await api(request,'GET',`documents/${note.id}?content=metadata`,undefined,owner)).title).toBe('accepted before archive');
    await archive(request,owner,book.id,false);await api(request,'PATCH',`documents/${note.id}`,{title:'restored'},owner);
  }finally{await writer.query('ROLLBACK');writer.release();await db.end();}
});

test('knowledge base filters, confirmation, read-only notice and restoration work in light and dark themes',async({page,request},info)=>{
  await isolated(request);const owner=await admin(request),name='界面归档 '+info.project.name+' '+randomUUID().slice(0,6),book=await api(request,'POST','spaces',{kind:'personal',name},owner);
  await api(request,'POST','documents',{space_id:book.id,title:'保留笔记'},owner);await login(page);await page.goto('/?page=personal&scope=personal');
  const cards=page.locator('.library-card').filter({has:page.getByRole('heading',{name,exact:true})});await expect(cards).toBeVisible();await cards.getByRole('button',{name:'管理知识库 '+name,exact:true}).click();
  await page.getByRole('dialog',{name:'管理知识库',exact:true}).getByRole('button',{name:'归档知识库',exact:true}).click();
  const confirm=page.getByRole('dialog',{name:'归档知识库',exact:true});await expect(confirm).toContainText('正文、附件、评论、历史版本');await confirm.getByRole('button',{name:'确认归档',exact:true}).click();await expect(confirm).toBeHidden();await expect(cards).toHaveCount(0);
  await page.getByLabel('知识库状态',{exact:true}).selectOption('archived');await expect(cards).toBeVisible();await expect(cards).toContainText('已归档 · 只读');
  for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:`artifacts/library-archive/${info.project.name}-${theme}.png`});}
  await cards.locator('.library-open').click();await expect(page.locator('.library-archive-notice')).toBeVisible();await expect(page.locator('.academic-page-actions').getByRole('button',{name:'新建笔记',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'恢复知识库',exact:true}).click();await page.getByRole('dialog',{name:'恢复知识库',exact:true}).getByRole('button',{name:'确认恢复',exact:true}).click();await expect(page.locator('.library-archive-notice')).toHaveCount(0);await expect(page.locator('.academic-page-actions').getByRole('button',{name:'新建笔记',exact:true})).toBeEnabled();
});

test('an open collaborating editor becomes read-only after archive without losing accepted text',async({page,request},info)=>{
  test.skip(info.project.name!=='desktop');await isolated(request);const owner=await admin(request),book=await api(request,'POST','spaces',{kind:'personal',name:'活动协作 '+randomUUID()},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'活动编辑'},owner);
  await login(page);await page.goto('/?scope=personal&doc='+note.id);const editor=page.getByTestId('editor');await expect(editor).toBeVisible();await expect(editor).toHaveAttribute("contenteditable","true");await editor.locator('p').first().click();await page.keyboard.insertText('归档前已经接收的文字');await expect(page.getByTestId('document-sync')).toHaveText('已同步');
  await archive(request,owner,book.id,true);await expect(editor).toHaveAttribute('contenteditable','false');await expect(page.locator(`[data-knowledge-library="${book.id}"]`)).toHaveCount(0);await expect(page.locator('.document-info')).toContainText('知识库已归档');expect(JSON.stringify((await api(request,'GET','documents/'+note.id,undefined,owner)).snapshot)).toContain('归档前已经接收的文字');
});

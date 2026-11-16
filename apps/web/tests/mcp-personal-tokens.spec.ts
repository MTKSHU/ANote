import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {api,login,openWorkspaceSettings,chooseTheme} from './helpers';
import {fixture,person,grant,register,connect,call,origin,scopes} from './mcp-helpers';

test.beforeEach(()=>{expect(process.env.ANOTE_ISOLATED_MCP_TEST,'This suite creates synthetic grants in an isolated Docker API only').toBe('1');});
const tokenHeaders=(token:string)=>({Authorization:'Bearer '+token});
const create=(request:APIRequestContext,owner:any,input:any={})=>api(request,'POST','me/integrations/tokens',{name:'SSH 令牌 '+randomUUID(),...input},owner);
const raw=(request:APIRequestContext,token:string)=>request.post('/mcp',{headers:tokenHeaders(token),data:{jsonrpc:'2.0',id:1,method:'tools/list'}});

test('SSH 个人令牌默认只读、遵守笔记 ACL，不接受网页登录会话且无法用于普通 API',async({request})=>{
  const f=await fixture(request),otherBook=await api(request,'POST','spaces',{kind:'personal',name:'另一个人的私有知识库'},f.peer),other=await api(request,'POST','documents',{space_id:otherBook.id,title:'不得泄露'},f.peer);
  const response=await request.post('/api/me/integrations/tokens',{headers:tokenHeaders(f.owner.token),data:{name:'SSH 默认只读'}});expect(response.status()).toBe(201);expect(response.headers()['cache-control']).toBe('no-store');
  const token=await response.json();expect(token.token).toMatch(/^anote_mcp_[\w-]{43}$/);expect(token.scopes).toEqual(['notes:read','assets:read']);expect(new Date(token.expires_at).getTime()-Date.now()).toBeGreaterThan(29*86400000);
  const client=await connect(token.token);
  try{
    const context=await call(client,'get_context');expect(context.user.id).toBe(f.owner.user.id);expect(context.scopes).toEqual(token.scopes);expect(context.schema_version).toBe(EDITOR_SCHEMA_VERSION);
    expect((await call(client,'read_note',{note_id:f.note.id})).title).toBe(f.note.title);await call(client,'read_note',{note_id:other.id},403);
    expect((await call(client,'list_notes')).items.some((item:any)=>item.id===other.id)).toBe(false);
    await call(client,'prepare_changes',{schema_version:EDITOR_SCHEMA_VERSION,library_id:f.book.id,operations:[]},403);
    expect((await request.get('/api/me',{headers:tokenHeaders(token.token)})).status()).toBe(401);
    expect((await raw(request,f.owner.token)).status()).toBe(401);
    const connections=await api(request,'GET','me/integrations',undefined,f.owner),listed=connections.connections.find((item:any)=>item.id===token.id);
    expect(listed).toMatchObject({authentication_type:'personal_token',client_name:'SSH 默认只读',scopes:token.scopes});expect(listed).not.toHaveProperty('token');expect(JSON.stringify(connections)).not.toContain(token.token);
  }finally{await client.close();await api(request,'DELETE','me/integrations/'+token.id,undefined,f.owner);}
});

test('既有 OAuth 与个人令牌独立；有效令牌可重新发现工具并按当前 schema 预览写入',async({request})=>{
  const f=await fixture(request),oauth=await grant(request,f.owner,'notes:read','既有 OAuth 保持有效'),token=await create(request,f.owner,{scopes:scopes.split(' ')});
  let client=await connect(token.token);const oauthClient=await connect(oauth.tokens.access_token);
  try{
    const tools=await client.listTools(),prepare=tools.tools.find(tool=>tool.name==='prepare_changes')!;
    expect((prepare.inputSchema.properties as any).schema_version).not.toHaveProperty('const');expect(prepare._meta?.['anote/schema_version']).toBe(EDITOR_SCHEMA_VERSION);expect(client.getServerVersion()).toEqual({name:'ANote',version:'1.1.10'});
    const before=await call(client,'read_note',{note_id:f.note.id}),stale=await call(client,'prepare_changes',{note_id:f.note.id,base_hash:before.base_hash,schema_version:EDITOR_SCHEMA_VERSION-1,operations:[]},409);
    expect(stale.schema_version).toBe(EDITOR_SCHEMA_VERSION);expect(stale.toolset_version).toBe(prepare._meta?.['anote/toolset_version']);expect(stale.retry).toContain('不得强制覆盖或自动重放');
    expect((await call(client,'read_note',{note_id:f.note.id})).base_hash).toBe(before.base_hash);
    await client.close();client=await connect(token.token);expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    const rules=await call(client,'get_editor_rules'),read=await call(client,'read_note',{note_id:f.note.id});
    const change=await call(client,'prepare_changes',{note_id:f.note.id,base_hash:read.base_hash,schema_version:rules.schema_version,operations:[{action:'insert',node:{type:'paragraph',content:[{type:'text',text:'SSH 授权后的新内容'}]}}]});
    await call(client,'apply_changes',{change_id:change.change_id,preview_hash:change.preview_hash,operation_id:randomUUID()});expect(JSON.stringify((await call(client,'read_note',{note_id:f.note.id})).blocks)).toContain('SSH 授权后的新内容');
    await api(request,'DELETE','me/integrations/'+token.id,undefined,f.peer);expect((await call(client,'get_context')).user.id).toBe(f.owner.user.id);
    const upload=await call(client,'begin_upload',{library_id:f.book.id,filename:'revoked.txt',bytes:3,sha256:createHash('sha256').update('abc').digest('hex')});
    await api(request,'DELETE','me/integrations/'+token.id,undefined,f.owner);expect((await raw(request,token.token)).status()).toBe(401);
    expect((await request.put(upload.upload_url,{headers:{'Content-Type':'application/octet-stream','Upload-Offset':'0','Upload-Sha256':createHash('sha256').update('abc').digest('hex')},data:Buffer.from('abc')})).status()).toBe(401);
    expect((await call(oauthClient,'get_context')).user.id).toBe(f.owner.user.id);
    const refreshed=await oauth.context.post('/token',{form:{grant_type:'refresh_token',client_id:oauth.client.client_id,refresh_token:oauth.tokens.refresh_token,resource:origin+'/mcp'}});expect(refreshed.status()).toBe(200);
    const renewed=await connect((await refreshed.json()).access_token);try{expect((await call(renewed,'get_context')).user.id).toBe(f.owner.user.id);}finally{await renewed.close();}
  }finally{await client.close();await oauthClient.close();await oauth.close();}
});

test('个人令牌只保存哈希，旧有效令牌可撤销，资源绑定、停用与到期均即时拒绝',async({request})=>{
  if(!process.env.DB_PASSWORD)throw new Error('Isolated DB_PASSWORD is required for token lifecycle assertions');
  const db=new Pool({host:'db',database:'anote',user:'anote',password:process.env.DB_PASSWORD,application_name:'anote-mcp-personal-token-validation'}),owner=await person(request),token=await create(request,owner,{expires_in_days:7});
  try{
    const stored=(await db.query("SELECT t.hash,t.kind,t.expires_at,g.client_id,g.resource,c.metadata FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id JOIN mcp_clients c ON c.id=g.client_id WHERE g.id=$1",[token.id])).rows;
    expect(stored).toHaveLength(1);expect(stored[0].hash).toBe(createHash('sha256').update(token.token).digest('hex'));expect(stored[0].kind).toBe('access');expect(stored[0].resource).toBe(origin+'/mcp');expect(JSON.stringify(stored)).not.toContain(token.token);
    const older=await create(request,owner,{name:'旧但有效的 SSH 令牌'}),historyClient=await register(request,'较新的已撤销 OAuth 历史'),historyIds=Array.from({length:100},()=>randomUUID());
    await db.query("UPDATE mcp_grants SET created_at=now()-interval '1 day' WHERE id=$1",[older.id]);
    await db.query("INSERT INTO mcp_grants(id,user_id,client_id,resource,scopes,created_at,revoked_at) SELECT id,$2,$3,$4,$5::text[],now(),now() FROM unnest($1::text[]) AS items(id)",[historyIds,owner.user.id,historyClient.client_id,origin+'/mcp',['notes:read']]);
    const visible=(await api(request,'GET','me/integrations',undefined,owner)).connections;expect(visible).toHaveLength(100);expect(visible.some((item:any)=>item.id===older.id&&!item.revoked_at)).toBe(true);
    await api(request,'DELETE','me/integrations/'+older.id,undefined,owner);expect((await raw(request,older.token)).status()).toBe(401);await db.query('DELETE FROM mcp_grants WHERE id=ANY($1::text[])',[historyIds]);
    expect((await request.post('/token',{form:{grant_type:'refresh_token',client_id:stored[0].client_id,refresh_token:token.token,resource:origin+'/mcp'}})).status()).not.toBe(200);
    await db.query("UPDATE mcp_grants SET resource='https://different.example/mcp' WHERE id=$1",[token.id]);expect((await raw(request,token.token)).status()).toBe(401);
    await db.query('UPDATE mcp_grants SET resource=$2 WHERE id=$1',[token.id,stored[0].resource]);
    await db.query('UPDATE users SET active=false WHERE id=$1',[owner.user.id]);expect((await raw(request,token.token)).status()).toBe(401);await db.query('UPDATE users SET active=true WHERE id=$1',[owner.user.id]);
    await db.query("UPDATE mcp_tokens SET expires_at=now()-interval '1 second' WHERE grant_id=$1",[token.id]);expect((await raw(request,token.token)).status()).toBe(401);
    await db.query('UPDATE mcp_tokens SET expires_at=$2 WHERE grant_id=$1',[token.id,stored[0].expires_at]);
    await db.query("UPDATE mcp_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[token.id]);expect((await raw(request,token.token)).status()).toBe(401);
  }finally{await db.query('UPDATE users SET active=true WHERE id=$1',[owner.user.id]);await db.end();await api(request,'DELETE','me/integrations/'+token.id,undefined,owner);}
});

test('令牌创建校验期限与权限，并发创建不会超过账号的20个有效令牌上限',async({request})=>{
  const owner=await person(request);
  for(const invalid of [{name:''},{expires_in_days:0},{expires_in_days:91},{expires_in_days:1.5},{scopes:[]},{scopes:['admin']},{scopes:'notes:read'}])await api(request,'POST','me/integrations/tokens',{name:'无效参数',...invalid},owner,400);
  const responses=await Promise.all(Array.from({length:21},(_,index)=>request.post('/api/me/integrations/tokens',{headers:tokenHeaders(owner.token),data:{name:'并发 SSH '+index,scopes:['notes:read'],expires_in_days:1}})));
  expect(responses.filter(response=>response.status()===201)).toHaveLength(20);expect(responses.filter(response=>response.status()===400)).toHaveLength(1);
  const connections=(await api(request,'GET','me/integrations',undefined,owner)).connections;expect(connections.filter((item:any)=>item.authentication_type==='personal_token'&&!item.revoked_at)).toHaveLength(20);
  for(const item of connections)await api(request,'DELETE','me/integrations/'+item.id,undefined,owner);
});

test('设置可创建、仅本次显示、隐藏和撤销 SSH 令牌，复制配置不含秘密',async({page,request})=>{
  const owner=await person(request);await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as any).__copiedMcpConfig=text;}}});});
  await login(page,owner);const settings=await openWorkspaceSettings(page);await settings.getByRole('button',{name:'AI工具链',exact:true}).click();
  const panel=settings.locator('.mcp-personal-token');await panel.locator('summary').click();
  await panel.getByLabel('MCP 令牌名称',{exact:true}).fill('浏览器创建 SSH');await panel.getByLabel('MCP 令牌有效期',{exact:true}).selectOption('7');
  await expect(panel.getByLabel('读取笔记',{exact:true})).toBeChecked();await expect(panel.getByLabel('编辑笔记',{exact:true})).not.toBeChecked();
  await panel.getByRole('button',{name:'创建 MCP 令牌',exact:true}).click();const secret=panel.getByLabel('MCP 令牌（仅本次显示）',{exact:true});await expect(secret).toHaveValue(/^anote_mcp_[\w-]{43}$/);const token=await secret.inputValue();
  await panel.getByRole('button',{name:'复制 Codex 令牌配置',exact:true}).click();await expect(settings.getByRole('status')).toHaveText('Codex 令牌配置已复制');const config=await page.evaluate(()=>(window as any).__copiedMcpConfig);expect(config).toContain('bearer_token_env_var = "ANOTE_MCP_TOKEN"');expect(config).not.toContain(token);
  await panel.getByRole('button',{name:'我已保存，隐藏令牌',exact:true}).click();await expect(secret).toHaveCount(0);
  await settings.getByRole('button',{name:'账号与偏好',exact:true}).click();await settings.getByRole('button',{name:'AI工具链',exact:true}).click();await expect(settings.getByLabel('MCP 令牌（仅本次显示）',{exact:true})).toHaveCount(0);
  const item=settings.locator('.mcp-connection-list article').filter({hasText:'浏览器创建 SSH'});await expect(item).toContainText('个人令牌');await expect(item).toContainText('读取笔记、读取附件');await item.getByRole('button',{name:'撤销令牌',exact:true}).click();await expect(item.getByRole('button',{name:'已撤销',exact:true})).toBeDisabled();expect((await raw(request,token)).status()).toBe(401);
  for(const theme of ['light','dark'] as const){await chooseTheme(page,theme);await expect(settings.getByLabel('MCP 接入地址',{exact:true})).toBeVisible();await page.screenshot({path:`artifacts/preview-051/mcp-token-settings-${theme}.png`});}
});

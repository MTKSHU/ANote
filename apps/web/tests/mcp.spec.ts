import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {test,expect} from "@playwright/test";
import fs from "node:fs/promises";
import {randomUUID,createHash} from "node:crypto";
import {Pool} from "pg";
import * as Y from "yjs";
import {findAnchor} from "@anote/document-model/anchors";
import {api,admin,login,typeBody,chooseTheme} from "./helpers";
import {origin,scopes,person,register,authorization,grant,connect,call,fixture,upload} from "./mcp-helpers";

test("Codex 动态本地回调端口：公共客户端无需密钥，授权码绑定实际回调",async({request})=>{
  const account=await person(request),client=await register(request,"Codex 动态端口");
  const actual={...client,redirect_uris:["http://127.0.0.1:53729/callback"]},flow=authorization(actual);
  const start=await request.get(flow.url,{maxRedirects:0});expect(start.status()).toBe(303);
  const id=new URL(start.headers().location).searchParams.get("mcp_authorize")!;
  await api(request,"GET","me/integrations/authorization/"+id,undefined,account);
  const decision=await api(request,"POST","me/integrations/authorization/"+id,{allow:true},account),callback=new URL(decision.redirect_uri);
  expect(callback.origin).toBe("http://127.0.0.1:53729");
  const form={grant_type:"authorization_code",client_id:client.client_id,code:callback.searchParams.get("code")!,code_verifier:flow.verifier,redirect_uri:actual.redirect_uris[0],resource:origin+"/mcp"};
  expect((await request.post("/token",{form:{...form,redirect_uri:client.redirect_uris[0]}})).status()).toBe(400);
  const response=await request.post("/token",{form});expect(response.status(),await response.text()).toBe(200);
  const connection=await connect((await response.json()).access_token);try{expect((await call(connection,"get_context")).user.id).toBe(account.user.id);}finally{await connection.close();}
});

test("OAuth 浏览器授权：登录后展示权限、取消、PKCE 校验、单次授权码和来源绑定",async({page,request})=>{
  const account=await person(request),client=await register(request,"Copilot 浏览器连接",true),flow=authorization(client);
  await page.route("http://127.0.0.1:33418/callback**",route=>route.fulfill({body:"Authorization returned"}));
  await page.goto(flow.url);await login(page,account);const consent=page.getByRole("dialog",{name:"连接 AI 应用",exact:true});
  await expect(consent).toContainText("Copilot 浏览器连接");await expect(consent).toContainText("读取与搜索");await expect(consent).toContainText(account.user.name);
  const pendingId=(await page.context().cookies()).find(c=>c.name==="anote_mcp_request")!.value.split(".")[0];await api(request,"GET","me/integrations/authorization/"+pendingId,undefined,account,400);
  await page.screenshot({path:"artifacts/web/mcp-oauth-consent.png"});await consent.getByRole("button",{name:"允许连接",exact:true}).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:33418\/callback/);const url=new URL(page.url());expect(url.searchParams.get("state")).toBe(flow.state);
  const form={grant_type:"authorization_code",client_id:client.client_id,client_secret:client.client_secret,code:url.searchParams.get("code")!,code_verifier:flow.verifier,redirect_uri:client.redirect_uris[0],resource:origin+"/mcp"};
  const wrong=await request.post("/token",{form:{...form,code_verifier:"wrong"}});expect(wrong.status()).toBe(400);
  expect((await request.post("/token",{form:{...form,resource:"https://example.test/mcp"}})).status()).toBe(400);
  const result=await request.post("/token",{form});expect(result.status(),await result.text()).toBe(200);const token=await result.json();expect(token.token_type).toBe("Bearer");expect(token.refresh_token).toBeTruthy();
  expect((await request.post("/token",{form})).status()).toBe(400);
  const another=authorization(client);await page.goto(another.url);await expect(consent).toBeVisible();await consent.getByRole("button",{name:"取消",exact:true}).click();await expect(page).toHaveURL(/error=access_denied/);
  const unauthorized=await request.post("/mcp",{data:{jsonrpc:"2.0",id:1,method:"tools/list"}});expect(unauthorized.status()).toBe(401);expect(unauthorized.headers()["www-authenticate"]).toContain("oauth-protected-resource/mcp");
  const discovery=await request.get("/.well-known/oauth-protected-resource/mcp");expect((await discovery.json()).resource).toBe(origin+"/mcp");
});

test("OAuth 令牌按应用隔离、刷新轮换不扩权，个人可撤销且不复用网页登录会话",async({request})=>{
  const account=await person(request),one=await grant(request,account,"notes:read","只读工具"),two=await grant(request,account,scopes,"可写工具");
  try{
    const c=await connect(one.tokens.access_token);await expect(async()=>{const context=await call(c,"get_context");expect(context.user.id).toBe(account.user.id);}).toPass();
    await call(c,"prepare_changes",{schema_version:EDITOR_SCHEMA_VERSION,library_id:"not-used",operations:[]},403);await c.close();
    const refresh={grant_type:"refresh_token",client_id:one.client.client_id,refresh_token:one.tokens.refresh_token,resource:origin+"/mcp"};
    expect((await one.context.post("/token",{form:{...refresh,scope:scopes}})).status()).toBe(400);
    const rotated=await one.context.post("/token",{form:refresh});expect(rotated.status(),await rotated.text()).toBe(200);const replacement=await rotated.json();
    const renewed=await connect(replacement.access_token);expect((await call(renewed,"get_context")).user.id).toBe(account.user.id);await renewed.close();
    expect((await one.context.post("/token",{form:refresh})).status()).toBe(400);
    expect((await one.context.post("/mcp",{headers:{Authorization:"Bearer "+replacement.access_token},data:{jsonrpc:"2.0",method:"tools/list",id:1}})).status()).toBe(401);
    expect((await one.context.post("/api/me",{headers:{Authorization:"Bearer "+replacement.access_token}})).status()).not.toBe(200);
    expect((await one.context.get("/api/me",{headers:{Authorization:"Bearer "+replacement.access_token}})).status()).toBe(401);
    const connections=await api(request,"GET","me/integrations",undefined,account),first=connections.connections.find((g:any)=>g.client_name==="只读工具");
    await api(request,"DELETE","me/integrations/"+first.id,undefined,account);
    const revoked=await one.context.post("/mcp",{headers:{Authorization:"Bearer "+replacement.access_token},data:{jsonrpc:"2.0",method:"tools/list",id:1}});expect(revoked.status()).toBe(401);
    const active=await connect(two.tokens.access_token);expect((await active.listTools()).tools.length).toBeGreaterThan(10);await active.close();
  }finally{await one.close();await two.close();}
});

test("MCP 检索遵守个人与团队权限，单篇分享与普通成员不能扩大编辑范围",async({request})=>{
  const{owner,peer,book,note}=await fixture(request),team=await api(request,"POST","teams",{name:"MCP 研究组"},owner),invite=await api(request,"POST",`teams/${team.id}/invites`,{},owner);
  await api(request,"POST",`team-invitations/${new URL(invite.path,origin).searchParams.get("invite")}/accept`,{},peer);
  const shared=await api(request,"POST","spaces",{kind:"team",team_id:team.id,name:"团队研究"},owner),publicNote=await api(request,"POST","documents",{space_id:shared.id,title:"团队可读笔记"},owner);
  await api(request,"POST","documents",{space_id:shared.id,title:"不能看到的私人研究",visibility:"private"},owner);
  const access=await grant(request,peer),client=await connect(access.tokens.access_token);
  try{
    const found=await call(client,"list_notes");expect(found.items.some((n:any)=>n.id===publicNote.id)).toBe(true);expect(found.items.some((n:any)=>n.id===note.id||n.title==="不能看到的私人研究")).toBe(false);
    await call(client,"read_note",{note_id:note.id},403);const read=await call(client,"read_note",{note_id:publicNote.id});
    await call(client,"prepare_changes",{note_id:publicNote.id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,title:"不允许篡改",operations:[]},403);
    const root=await admin(request),rootGrant=await grant(request,root),rootClient=await connect(rootGrant.tokens.access_token);try{await call(rootClient,"read_note",{note_id:note.id},403);}finally{await rootClient.close();await rootGrant.close();}
    const sharing=await api(request,"GET",`documents/${note.id}/sharing`,undefined,owner);await api(request,"PATCH",`documents/${note.id}/sharing`,{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:peer.user.id,role:"viewer"}]},owner);
    expect((await call(client,"read_note",{note_id:note.id})).title).toBe(note.title);expect((await call(client,"list_libraries")).items.some((s:any)=>s.id===book.id)).toBe(false);
  }finally{await client.close();await access.close();}
});

test("完整富文本与附件先预览后原子创建，表格、导图、多图、公式和历史来源可往返",async({page,request})=>{
  const{owner,book}=await fixture(request),access=await grant(request,owner,scopes,"Copilot 富文本验证"),client=await connect(access.tokens.access_token);
  const db=new Pool({host:"db",database:"anote",user:"anote",password:process.env.DB_PASSWORD});
  try{
    const bytes=await fs.readFile("artifacts/server/fixtures/sample.png"),a=await upload(client,request,bytes,{library_id:book.id},"实验结果甲.png"),b=await upload(client,request,bytes,{library_id:book.id},"实验结果乙.png");
    expect((await db.query("SELECT count(*)::int AS n FROM assets WHERE id=ANY($1::text[])",[[a.upload_id,b.upload_id]])).rows[0].n).toBe(0);
    const paragraph=(text:string)=>({type:"paragraph",content:[{type:"text",text}]}),cell=(text:string,colspan=1)=>({type:"tableCell",attrs:{colspan,rowspan:1},content:[paragraph(text)]});
    const nodes:any[]=[
      {type:"heading",attrs:{level:2},content:[{type:"text",text:"MCP 完整实验"}]},
      {type:"paragraph",content:[{type:"text",text:"斜体结论",marks:[{type:"italic"},{type:"textStyle",attrs:{color:"#3366aa",fontSize:20,backgroundColor:"#fff2a8"}}]},{type:"inlineMath",attrs:{latex:"X_t"}}]},
      {type:"table",content:[{type:"tableRow",content:[cell("合并表头",2)]},{type:"tableRow",content:[cell("模型 A"),cell("模型 B")]}]},
      {type:"mindMap",content:[{type:"mindMapItem",attrs:{id:"root",parentId:null,x:320,y:180},content:[{type:"text",text:"研究"}]},{type:"mindMapItem",attrs:{id:"child",parentId:"root",x:600,y:260},content:[{type:"text",text:"实验"}]}]},
      {type:"imageComparison",attrs:{images:[{assetId:a.upload_id,label:"方法 A"},{assetId:b.upload_id,label:"方法 B"}],layout:"slider"}},
      {type:"mediaResource",attrs:{assetId:a.upload_id}},
      {type:"codeBlock",attrs:{language:"mermaid"},content:[{type:"text",text:"flowchart LR\nA-->B"}]},
      {type:"mathBlock",attrs:{latex:"X_t = X_0 + t"}}
    ];
    const proposal=await call(client,"prepare_changes",{library_id:book.id,title:"AI 创建的富文本实验",tags:["MCP","保真"],schema_version:EDITOR_SCHEMA_VERSION,operations:nodes.map(node=>({action:"insert",node}))});
    expect((await api(request,"GET","documents?space="+book.id,undefined,owner)).length).toBe(1);
    expect(proposal.diff.some((d:any)=>d.after?.type==="table")).toBe(true);
    const args={change_id:proposal.change_id,preview_hash:proposal.preview_hash,operation_id:randomUUID()};
    await call(client,"apply_changes",{...args,preview_hash:"wrong"},409);
    const result=await call(client,"apply_changes",args),duplicate=await call(client,"apply_changes",args);expect(duplicate.replayed).toBe(true);expect(duplicate.doc_id).toBe(result.doc_id);
    let read=await call(client,"read_note",{note_id:result.doc_id});expect(read.blocks).toHaveLength(8);expect(read.blocks[2].content[0].content[0].attrs.colspan).toBe(2);expect(read.blocks[3].content[1].attrs.x).toBe(600);expect(read.blocks[4].attrs.images).toHaveLength(2);expect(read.blocks[1].content[0].marks.some((m:any)=>m.type==="textStyle")).toBe(true);
    const comment=await api(request,"POST",`documents/${result.doc_id}/comments`,{text:"表格评论保留",anchor:{blockId:read.blocks[2].attrs.blockId,quote:"合并表头\n模型 A\n模型 B"}},owner);
    const ydoc=new Y.Doc();Y.applyUpdate(ydoc,(await db.query("SELECT ystate FROM documents WHERE id=$1",[result.doc_id])).rows[0].ystate);const anchor=findAnchor(ydoc,"模型 A");expect(anchor).toBeTruthy();const selectedComment=await api(request,"POST",`documents/${result.doc_id}/comments`,{text:"单元格选区锚点保留",anchor},owner);ydoc.destroy();
    const old=structuredClone(read.blocks),textNode=structuredClone(read.blocks[1]);textNode.content[0].text="更新后的斜体结论";
    const update=await call(client,"prepare_changes",{note_id:result.doc_id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:"replace",block_id:textNode.attrs.blockId,node:textNode}]});
    await call(client,"apply_changes",{change_id:update.change_id,preview_hash:update.preview_hash,operation_id:randomUUID()});read=await call(client,"read_note",{note_id:result.doc_id});
    expect(read.blocks[2]).toEqual(old[2]);expect(read.blocks[3]).toEqual(old[3]);expect(read.blocks[4]).toEqual(old[4]);expect(read.blocks[1].content[0].marks).toEqual(old[1].content[0].marks);
    const comments=await api(request,"GET",`documents/${result.doc_id}/comments`,undefined,owner);expect(comments.find((c:any)=>c.id===comment.id).resolvedAnchor.orphaned).toBe(false);
    expect(comments.find((c:any)=>c.id===selectedComment.id).resolvedAnchor).toMatchObject({orphaned:false,text:"模型 A"});
    const versions=await api(request,"GET",`documents/${result.doc_id}/versions`,undefined,owner);expect(versions[0].integration_client).toBe("Copilot 富文本验证");expect(versions[0].editors.map((e:any)=>e.id)).toContain(owner.user.id);
    await login(page,owner);await page.goto("/?doc="+result.doc_id);await expect(page.getByTestId("editor")).toContainText("更新后的斜体结论");await expect(page.getByTestId("image-comparison")).toBeVisible();await expect(page.getByTestId("mind-map")).toBeVisible();await expect(page.locator(".math-block .katex")).toBeVisible();await page.screenshot({path:"artifacts/web/mcp-rich-note.png"});
  }finally{await db.end();await client.close();await access.close();}
});

test("AI 预览不覆盖后续协作修改，过期提交拒绝，网页能实时收到成功修改",async({page,request})=>{
  const{owner,note}=await fixture(request),access=await grant(request,owner),client=await connect(access.tokens.access_token);
  try{
    await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toBeVisible();
    const read=await call(client,"read_note",{note_id:note.id}),proposal=await call(client,"prepare_changes",{note_id:note.id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:"replace",block_id:read.blocks[0].attrs.blockId,node:{type:"paragraph",content:[{type:"text",text:"AI 修改"}]}}]});
    await typeBody(page,"网页协作中的最新内容。");await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存");
    await call(client,"apply_changes",{change_id:proposal.change_id,preview_hash:proposal.preview_hash,operation_id:randomUUID()},409);await expect(page.getByTestId("editor")).toContainText("网页协作中的最新内容。");await expect(page.getByTestId("editor")).not.toContainText("AI 修改");
    const latest=await call(client,"read_note",{note_id:note.id}),fresh=await call(client,"prepare_changes",{note_id:note.id,base_hash:latest.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:"insert",node:{type:"paragraph",content:[{type:"text",text:"AI 确认后的新段落"}]}}]});
    await call(client,"apply_changes",{change_id:fresh.change_id,preview_hash:fresh.preview_hash,operation_id:randomUUID()});await expect(page.getByTestId("editor")).toContainText("AI 确认后的新段落");await expect(page.getByTestId("editor")).toContainText("网页协作中的最新内容。");
    const db=new Pool({host:"db",database:"anote",user:"anote",password:process.env.DB_PASSWORD});try{const current=await call(client,"read_note",{note_id:note.id}),expired=await call(client,"prepare_changes",{note_id:note.id,base_hash:current.base_hash,schema_version:EDITOR_SCHEMA_VERSION,title:"过期内容不能提交",operations:[]});await db.query("UPDATE mcp_changes SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.change_id]);await call(client,"apply_changes",{change_id:expired.change_id,preview_hash:expired.preview_hash,operation_id:randomUUID()},409);}finally{await db.end();}
  }finally{await client.close();await access.close();}
});

test("暂存附件不跨连接共享，取消使原子提交回滚，撤销编辑权限后预览不能提交",async({request})=>{
  const{owner,peer,book,note}=await fixture(request),access=await grant(request,owner),other=await grant(request,peer),client=await connect(access.tokens.access_token),peerClient=await connect(other.tokens.access_token);
  const db=new Pool({host:"db",database:"anote",user:"anote",password:process.env.DB_PASSWORD});
  try{
    const bytes=await fs.readFile("artifacts/server/fixtures/sample.png"),first=await upload(client,request,bytes,{library_id:book.id},"事务甲.png"),second=await upload(client,request,bytes,{library_id:book.id},"事务乙.png");
    await call(peerClient,"upload_status",{upload_id:first.upload_id},404);
    const draft=await call(client,"prepare_changes",{library_id:book.id,title:"不能部分发布",schema_version:EDITOR_SCHEMA_VERSION,operations:[first,second].map(a=>({action:"insert",node:{type:"mediaResource",attrs:{assetId:a.upload_id}}}))});
    await call(client,"cancel_upload",{upload_id:second.upload_id});
    await call(client,"apply_changes",{change_id:draft.change_id,preview_hash:draft.preview_hash,operation_id:randomUUID()},409);
    expect((await db.query("SELECT count(*)::int AS n FROM assets WHERE id=ANY($1::text[])",[[first.upload_id,second.upload_id]])).rows[0].n).toBe(0);
    expect((await call(client,"list_notes",{library_id:book.id})).items).toHaveLength(1);
    expect((await call(client,"upload_status",{upload_id:first.upload_id})).status).toBe("ready");
    const retry=await call(client,"prepare_changes",{library_id:book.id,title:"回滚后可继续",schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:"insert",node:{type:"mediaResource",attrs:{assetId:first.upload_id}}}]});
    await call(client,"apply_changes",{change_id:retry.change_id,preview_hash:retry.preview_hash,operation_id:randomUUID()});
    const failed=await call(client,"import_chatgpt_file",{library_id:book.id,file:{download_url:"https://127.0.0.1/private",file_id:"file-private",file_name:"不允许.png"}});
    await expect.poll(async()=> (await call(client,"upload_status",{upload_id:failed.upload_id})).status).toBe("failed");
    async function share(role?:string){const current=await api(request,"GET",`documents/${note.id}/sharing`,undefined,owner);await api(request,"PATCH",`documents/${note.id}/sharing`,{visibility:"private",access_revision:current.access_revision,collaborators:role?[{user_id:peer.user.id,role}]:[]},owner);}
    await share("editor");const read=await call(peerClient,"read_note",{note_id:note.id}),pending=await call(peerClient,"prepare_changes",{note_id:note.id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,title:"撤权后不能提交",operations:[]});
    await share("viewer");await call(peerClient,"apply_changes",{change_id:pending.change_id,preview_hash:pending.preview_hash,operation_id:randomUUID()},403);
    expect((await call(client,"read_note",{note_id:note.id})).title).toBe(note.title);
    await api(request,"DELETE","spaces/"+book.id,undefined,owner);
    const deleted=(await api(request,"GET","trash/spaces",undefined,owner)).find((s:any)=>s.id===book.id);
    await api(request,"DELETE","trash/spaces/"+book.id,{deletion_token:deleted.trash_batch},owner);
    expect((await db.query("SELECT count(*)::int AS n FROM mcp_changes WHERE space_id=$1",[book.id])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM mcp_uploads WHERE space_id=$1",[book.id])).rows[0].n).toBe(0);
  }finally{await db.end();await client.close();await peerClient.close();await access.close();await other.close();}
});

test("AI 连接设置明暗主题、复制反馈、撤销操作与固定设置布局兼容",async({page,request})=>{
  const account=await person(request),access=await grant(request,account,scopes,"设置中的 AI 应用");
  try{
    await login(page,account);for(const theme of ["light","dark"] as const){await chooseTheme(page,theme);await page.locator(".academic-user").getByRole("button",{name:"设置",exact:true}).click();const settings=page.getByRole("dialog",{name:"设置",exact:true});await settings.getByRole("button",{name:"AI工具链",exact:true}).click();await expect(settings.getByLabel("MCP 接入地址",{exact:true})).toHaveValue(origin+"/mcp");await expect(settings.locator(".mcp-connection-list")).toContainText("设置中的 AI 应用");await settings.getByRole("button",{name:"复制 Copilot 配置",exact:true}).click();await expect(settings.getByRole("status")).toHaveText("配置已复制");await page.screenshot({path:`artifacts/web/mcp-settings-${theme}.png`});await settings.getByRole("button",{name:"关闭",exact:true}).click();}
    await page.locator(".academic-user").getByRole("button",{name:"设置",exact:true}).click();const settings=page.getByRole("dialog",{name:"设置",exact:true});await settings.getByRole("button",{name:"AI工具链",exact:true}).click();await settings.getByRole("button",{name:"撤销连接",exact:true}).click();await expect(settings.getByRole("button",{name:"已撤销",exact:true})).toBeDisabled();
  }finally{await access.close();}
});

test("超过单块上限的附件分块续传、错块校验和授权撤销均正确生效",async({request})=>{
  const{owner,book}=await fixture(request),access=await grant(request,owner),client=await connect(access.tokens.access_token),bytes=Buffer.alloc(16*1024*1024+1024,65),hash=(data:Buffer)=>createHash("sha256").update(data).digest("hex");
  try{
    const input={library_id:book.id,filename:"大附件.bin",bytes:bytes.length,sha256:hash(bytes)},start=await call(client,"begin_upload",input),part=bytes.subarray(0,start.chunk_bytes);
    const put=(url:string,data:Buffer,offset:number,sha256=hash(data))=>request.put(url,{headers:{"Content-Type":"application/octet-stream","Upload-Offset":String(offset),"Upload-Sha256":sha256},data});
    expect((await put(start.upload_url,part,0,"0".repeat(64))).status()).toBe(422);
    expect((await call(client,"upload_status",{upload_id:start.upload_id})).offset).toBe(0);
    expect((await put(start.upload_url,part,0)).status()).toBe(200);
    const resume=await call(client,"begin_upload",input);expect(resume.upload_id).toBe(start.upload_id);expect(resume.offset).toBe(part.length);
    expect((await put(start.upload_url,bytes.subarray(part.length),part.length)).status()).toBe(401);
    expect((await put(resume.upload_url,bytes.subarray(part.length),part.length)).status()).toBe(200);
    expect((await call(client,"complete_upload",{upload_id:start.upload_id})).hash).toBe(input.sha256);
    const second=await call(client,"begin_upload",{...input,filename:"撤销后不能上传.bin"}),connections=await api(request,"GET","me/integrations",undefined,owner),connection=connections.connections.find((g:any)=>!g.revoked_at);
    await api(request,"DELETE","me/integrations/"+connection.id,undefined,owner);expect((await put(second.upload_url,part,0)).status()).toBe(401);
  }finally{await client.close();await access.close();}
});

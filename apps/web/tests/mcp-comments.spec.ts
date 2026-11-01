import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api} from "./helpers";
import {fixture,grant,connect,call} from "./mcp-helpers";
import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";

async function setup(request:any){
  const data=await fixture(request),access=await grant(request,data.owner,"notes:read notes:write"),client=await connect(access.tokens.access_token);
  try{
    const note=await call(client,"read_note",{note_id:data.note.id}),block=randomUUID(),quote="需要讨论的实验结论";
    const preview=await call(client,"prepare_changes",{note_id:data.note.id,base_hash:note.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:"insert",node:{type:"paragraph",attrs:{blockId:block},content:[{type:"text",text:quote}]}}]});
    await call(client,"apply_changes",{change_id:preview.change_id,preview_hash:preview.preview_hash,operation_id:randomUUID()});
    const current=await call(client,"read_note",{note_id:data.note.id}),actualBlock=current.blocks.find((n:any)=>n.content?.[0]?.text===quote).attrs.blockId;
    const root=await api(request,"POST",`documents/${data.note.id}/comments`,{text:"补充对照实验",anchor:{blockId:actualBlock,quote}},data.owner);
    const reply=await api(request,"POST",`documents/${data.note.id}/comments`,{text:"下周补齐",parent_id:root.id},data.owner);
    const resolved=await api(request,"POST",`documents/${data.note.id}/comments`,{text:"已确认的数据来源",anchor:{blockId:actualBlock,quote}},data.owner);
    await api(request,"PATCH",`documents/${data.note.id}/comments/${resolved.id}`,{resolved:true},data.owner);
    return {...data,root,reply,resolved,quote};
  }finally{await client.close();await access.close();}
}

test("MCP 只读授权分页读取评论、回复、实时昵称、解决状态和原文定位，网页接口保持完整",async({request})=>{
  const data=await setup(request),access=await grant(request,data.owner,"notes:read"),client=await connect(access.tokens.access_token);
  try{
    await api(request,"PATCH","me/profile",{name:"评论者新昵称"},data.owner);
    const before=await api(request,"GET",`documents/${data.note.id}`,undefined,data.owner);
    const tools=await client.listTools(),tool=tools.tools.find(t=>t.name==="list_note_comments")!;expect(tool.annotations?.readOnlyHint).toBe(true);
    const first=await call(client,"list_note_comments",{note_id:data.note.id,limit:2});expect(first.items).toHaveLength(2);expect(first.next_offset).toBe(2);
    const last=await call(client,"list_note_comments",{note_id:data.note.id,offset:first.next_offset,limit:2});expect(last.items).toHaveLength(1);expect(last.next_offset).toBeNull();
    const all=[...first.items,...last.items];expect(new Set(all.map((c:any)=>c.id)).size).toBe(3);expect(all.map((c:any)=>c.author_name)).toEqual(["评论者新昵称","评论者新昵称","评论者新昵称"]);
    expect(all.find((c:any)=>c.id===data.reply.id).parent_id).toBe(data.root.id);expect(all.find((c:any)=>c.id===data.root.id).resolved_anchor).toMatchObject({text:data.quote,orphaned:false});expect(all.find((c:any)=>c.id===data.resolved.id).resolved).toBe(true);
    for(const row of all){expect(row.created_at).toBeTruthy();expect(row).not.toHaveProperty("email");expect(row).not.toHaveProperty("username");expect(row).not.toHaveProperty("author");}
    expect((await call(client,"list_note_comments",{note_id:data.note.id,resolved:false})).items.map((c:any)=>c.id)).toEqual([data.root.id,data.reply.id]);
    await api(request,"PATCH",`documents/${data.note.id}/comments/${data.root.id}`,{resolved:true},data.owner);
    const closed=await call(client,"list_note_comments",{note_id:data.note.id,resolved:true});expect(closed.items).toHaveLength(3);expect(closed.items.every((c:any)=>c.resolved)).toBe(true);
    const web=await api(request,"GET",`documents/${data.note.id}/comments`,undefined,data.owner);expect(web).toHaveLength(3);expect(web.find((c:any)=>c.id===data.root.id).resolvedAnchor.text).toBe(data.quote);
    const after=await api(request,"GET",`documents/${data.note.id}`,undefined,data.owner);expect(after.snapshot).toEqual(before.snapshot);expect(after.revision).toBe(before.revision);
    await call(client,"list_note_comments",{note_id:data.note.id,limit:51},400);
  }finally{await client.close();await access.close();}
});

test("MCP 评论遵守私人笔记和明确授权，撤销权限或 OAuth 后不能读取",async({request})=>{
  const data=await setup(request),access=await grant(request,data.peer,"notes:read","评论读取权限验证"),client=await connect(access.tokens.access_token);
  try{
    await call(client,"list_note_comments",{note_id:data.note.id},403);
    let sharing=await api(request,"GET",`documents/${data.note.id}/sharing`,undefined,data.owner);
    await api(request,"PATCH",`documents/${data.note.id}/sharing`,{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:data.peer.user.id,role:"viewer"}]},data.owner);
    expect((await call(client,"list_note_comments",{note_id:data.note.id})).items).toHaveLength(3);
    sharing=await api(request,"GET",`documents/${data.note.id}/sharing`,undefined,data.owner);
    await api(request,"PATCH",`documents/${data.note.id}/sharing`,{visibility:"private",access_revision:sharing.access_revision,collaborators:[]},data.owner);
    await call(client,"list_note_comments",{note_id:data.note.id},403);
    const integrations=await api(request,"GET","me/integrations",undefined,data.peer),connection=integrations.connections.find((c:any)=>c.client_name==="评论读取权限验证");expect(connection).toBeTruthy();
    await api(request,"DELETE","me/integrations/"+connection.id,undefined,data.peer);
    const response=await request.post("/mcp",{headers:{Authorization:"Bearer "+access.tokens.access_token},data:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"list_note_comments",arguments:{note_id:data.note.id}}}});expect(response.status()).toBe(401);
  }finally{await client.close();await access.close();}
});

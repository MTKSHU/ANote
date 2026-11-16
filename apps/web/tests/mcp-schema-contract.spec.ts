import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {fixture,grant,connect,call} from "./mcp-helpers";
import {api} from "./helpers";
test("MCP 工具定义、初始化版本、规则资源、读取和实际预览／写入使用同一 schema",async({request})=>{
  const f=await fixture(request),authorization=await grant(request,f.owner),client=await connect(authorization.tokens.access_token);try{
    const tools=await client.listTools(),definition=tools.tools.find(tool=>tool.name==="prepare_changes")!,schema=definition._meta?.["anote/schema_version"];
    expect((definition.inputSchema.properties as any).schema_version).toMatchObject({type:"integer",minimum:1});expect((definition.inputSchema.properties as any).schema_version).not.toHaveProperty("const");
    expect(schema).toBe(EDITOR_SCHEMA_VERSION);expect(definition._meta?.["anote/schema_version"]).toBe(schema);expect(client.getServerVersion()).toEqual({name:"ANote",version:'1.1.10'});expect(client.getInstructions()).toContain(`schema ${schema}`);
    const rules=await call(client,"get_editor_rules"),context=await call(client,"get_context");expect(rules.schema_version).toBe(schema);expect(context.toolset_version).toBe('1.1.10');expect(rules.node_types.imageComparison.attributes.orientation).toBe("horizontal");
    const resources=await client.listResources(),resource=await client.readResource({uri:resources.resources[0].uri});expect(JSON.parse((resource.contents[0] as any).text).schema_version).toBe(schema);
    const note=await call(client,"read_note",{note_id:f.note.id});expect(note.schema_version).toBe(schema);const stale=await call(client,"prepare_changes",{note_id:f.note.id,base_hash:note.base_hash,schema_version:Number(schema)-1,operations:[]},409);expect(stale.error).toContain(`schema ${schema}`);
    const change=await call(client,"prepare_changes",{note_id:f.note.id,base_hash:note.base_hash,schema_version:schema,operations:[{action:"insert",node:{type:"paragraph",content:[{type:"text",text:"新工具定义下的真实写入"}]}}]});expect(change.change_id).toBeTruthy();await call(client,"apply_changes",{change_id:change.change_id,preview_hash:change.preview_hash,operation_id:randomUUID()});expect(JSON.stringify((await call(client,"read_note",{note_id:f.note.id})).blocks)).toContain("新工具定义下的真实写入");expect((await api(request,"GET",`documents/${f.note.id}/info`,undefined,f.owner)).last_editors).toEqual([{name:f.owner.user.name}]);
  }finally{await client.close();await authorization.close();}
});

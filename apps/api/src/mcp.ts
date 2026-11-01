import express,{type Request,type Response,type NextFunction} from "express";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {AjvJsonSchemaValidator} from "@modelcontextprotocol/sdk/validation/ajv";
import {mcpAuthRouter,getOAuthProtectedResourceMetadataUrl} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {requireBearerAuth} from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {InvalidTokenError} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {Documents} from "./documents.js";
import {McpService} from "./mcp-service.js";
import {mcpOAuth,mcpIdentity,mcpOrigin,mcpResource,MCP_SCOPES} from "./mcp-auth.js";
import {receiveMcpChunk,cleanMcpStaging} from "./mcp-files.js";
import {platformConfig} from "./platform.js";
import {editorRules} from "./mcp-model.js";
import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {fail} from "./errors.js";

const str={type:"string",minLength:1,maxLength:200};
const paging={offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:50}};
const target={note_id:str,library_id:str};
const file={type:"object",properties:{download_url:{type:"string"},file_id:{type:"string"},file_name:{type:"string"},mime_type:{type:"string"}},required:["download_url","file_id"],additionalProperties:false};
function tool(name:string,description:string,properties:any={},required:string[]=[],write=false,extra:any={}){
  const scopes=["apply_changes","prepare_changes","prepare_note_move"].includes(name)?["notes:write"]:name.includes("upload")||name==="import_chatgpt_file"?["notes:write","assets:write"]:name.includes("asset")?["assets:read"]:["notes:read"];
  const securitySchemes=[{type:"oauth2",scopes}];
  return {name,description,inputSchema:{type:"object" as const,properties,required,additionalProperties:false},securitySchemes,annotations:{readOnlyHint:!write,destructiveHint:write&&name==="apply_changes",openWorldHint:name==="import_chatgpt_file",idempotentHint:["apply_changes","complete_upload","cancel_upload"].includes(name)},_meta:{securitySchemes,...extra}};
}
export const mcpTools=[
  tool("get_context","识别当前连接的账号、授权范围和 ANote 编辑规则。首次操作时使用。",{},[],false,{"openai/profile":true}),
  tool("get_editor_rules","获取当前富文本 schema、节点属性、操作格式和示例。准备编辑前使用。"),
  tool("list_libraries","按当前账号权限分页列出个人和团队知识库。",paging),
  tool("list_notes","搜索或分页列出可读笔记；可按知识库筛选。",{...paging,library_id:str,query:{type:"string",maxLength:200},archived:{type:"boolean"}}),
  tool("list_folders","列出一个可访问知识库中的目录，供新笔记选择位置。",{library_id:str},["library_id"]),
  tool("read_note","按块分页读取笔记，获取稳定 blockId、富文本内容和 base_hash。",{...paging,note_id:str},["note_id"]),
  tool("list_note_comments","按需分页读取指定笔记的评论和回复，包括昵称、时间、解决状态和原文定位；遵守该笔记的阅读权限。",{...paging,note_id:str,resolved:{type:"boolean"}},["note_id"]),
  tool("prepare_note_move","仅在同一团队的知识库之间或本人个人知识库之间生成移动预览，禁止跨团队或个人与团队互转。保留笔记链接、正文、附件、评论和历史；撤销原指定授权及外链。向用户展示目标和可见范围，确认后调用 apply_changes。",{note_id:str,library_id:str,folder_id:str,visibility:{type:"string",enum:["private","team"]}},["note_id","library_id"],true),
  tool("search_assets","搜索目标笔记所在知识库中有权读取的附件，不返回他人的私人资源。",{...paging,note_id:str,query:{type:"string",maxLength:200}},["note_id"]),
  tool("read_asset","按需读取附件元信息、小图片或文本；不会批量上传知识库。",{asset_id:str},["asset_id"]),
  tool("prepare_changes","生成新建或编辑笔记的完整差异预览；不修改正式笔记。编辑需 note_id+base_hash，新建需 library_id；向用户展示差异后才能保存。",{...target,base_hash:str,folder_id:str,schema_version:{type:"integer",const:EDITOR_SCHEMA_VERSION},title:{type:"string",minLength:1,maxLength:200},tags:{type:"array",maxItems:30,items:{type:"string",maxLength:40}},operations:{type:"array",maxItems:500,items:{type:"object",properties:{action:{type:"string",enum:["insert","replace","delete","move"]},block_id:str,before_id:{anyOf:[str,{type:"null"}]},node:{type:"object"}},required:["action"],additionalProperties:false}}},["schema_version","operations"],true),
  tool("apply_changes","仅在用户已在聊天中确认 prepare_changes 的差异后调用。提交该预览；若笔记更新或预览过期，须重新读取并展示差异，不得强制覆盖。",{change_id:str,preview_hash:str,operation_id:{type:"string",minLength:10,maxLength:100}},["change_id","preview_hash","operation_id"],true),
  tool("begin_upload","为电脑上的本地文件创建私有暂存上传。返回短期分块 PUT 地址；由客户端本机终端传输，服务器无法读取本地文件路径。",{...target,filename:str,bytes:{type:"integer",minimum:1},sha256:{type:"string",pattern:"^[a-f0-9]{64}$"}},["filename","bytes","sha256"],true),
  tool("upload_status","查询当前连接自己的暂存附件状态及续传偏移。",{upload_id:str},["upload_id"]),
  tool("complete_upload","分块传输完成后校验文件。文件仍为私有暂存，apply_changes 后才正式引用。",{upload_id:str},["upload_id"],true),
  tool("cancel_upload","取消尚未正式引用的暂存附件。",{upload_id:str},["upload_id"],true),
  tool("import_chatgpt_file","将用户在 ChatGPT 中提供的文件传到私有暂存；使用原生文件参数，下载由服务端完成，随后调用 upload_status。",{...target,file},["file"],true,{"openai/fileParams":["file"]})
];
const validator=new AjvJsonSchemaValidator();
const validations=new Map(mcpTools.map(t=>[t.name,validator.getValidator(t.inputSchema as any)]));
export function installMcp(app:express.Express,documents:Documents){
  const service=new McpService(documents);let origin="",oauthRouter:express.RequestHandler;
  app.use((req,res,next)=>{
    if(!["/authorize","/token","/register","/revoke"].includes(req.path)&&!req.path.startsWith("/.well-known/"))return next();
    try{
      if(origin!==mcpOrigin()){
        // A cached router is rebuilt only after a public-domain configuration change.
        const nextOrigin=mcpOrigin(),validate={creationStack:false};oauthRouter=mcpAuthRouter({provider:mcpOAuth,issuerUrl:new URL(nextOrigin),resourceServerUrl:new URL(mcpResource()),scopesSupported:MCP_SCOPES,resourceName:platformConfig().site_name,authorizationOptions:{rateLimit:{validate}},revocationOptions:{rateLimit:{validate}},clientRegistrationOptions:{clientSecretExpirySeconds:0,rateLimit:{max:100,validate}},tokenOptions:{rateLimit:{max:1000,validate}}});origin=nextOrigin;
      }
      return oauthRouter(req,res,next);
    }catch(error){next(error);}
  });
  const safe=(fn:(req:Request,res:Response)=>Promise<any>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
  app.put("/mcp-upload/:id",safe(receiveMcpChunk));
  app.all("/mcp",(req,res,next)=>{
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");
    const supplied=req.headers.origin;
    if(supplied&&![mcpOrigin(),...platformConfig().allowed_origins,"https://chatgpt.com","https://vscode.dev","https://insiders.vscode.dev"].includes(supplied)){res.status(403).json({error:"MCP 请求来源不匹配"});return;}
    requireBearerAuth({verifier:mcpOAuth,expectedResource:new URL(mcpResource()),resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(new URL(mcpResource()))})(req,res,()=>{
      void (async()=>{
        if(req.method!=="POST"){res.status(405).setHeader("Allow","POST").json({jsonrpc:"2.0",id:null,error:{code:-32000,message:"Use stateless Streamable HTTP POST"}});return;}
        const auth=req.auth!;
        const server=new Server({name:"ANote",version:"1.0.0"},{capabilities:{tools:{},resources:{}},instructions:editorRules().workflow});
        server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:mcpTools}));
        server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:"anote://editor-rules",name:"ANote 富文本编辑规则",mimeType:"application/json"}]}));
        server.setRequestHandler(ReadResourceRequestSchema,async request=>{
          await mcpIdentity(auth);if(request.params.uri!=="anote://editor-rules")throw new Error("Unknown resource");return {contents:[{uri:request.params.uri,mimeType:"application/json",text:JSON.stringify(editorRules())}]};
        });
        server.setRequestHandler(CallToolRequestSchema,async request=>{
          try{
            const validate=validations.get(request.params.name);if(!validate)fail(404,"没有此 MCP 工具");const valid=validate(request.params.arguments||{});if(!valid.valid)fail(400,"工具参数不符合格式："+valid.errorMessage);
            const identity=await mcpIdentity(auth),result=await service.call(request.params.name,identity,request.params.arguments||{});
            const {image,...details}=result as any;
            return {content:[{type:"text" as const,text:JSON.stringify(details)},...(image?[image]:[])],structuredContent:details};
          }catch(error){const e=error as any,status=e.getStatus?.()||(error instanceof InvalidTokenError?401:500),message=e.getResponse?.()?.error||(status===401?"连接已失效，请重新授权":"工具执行失败，请稍后重试");if(status===500)console.error("MCP tool failed:",request.params.name,e.message);return {isError:true,content:[{type:"text" as const,text:JSON.stringify({error:message,status,retry:status===409?"重新读取并预览；不得强制覆盖":undefined})}]};}
        });
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        res.on("close",()=>{void transport.close();void server.close();});
        await server.connect(transport);await transport.handleRequest(req,res,req.body);
      })().catch(next);
    });
  });
  let cleaning=false;const clean=async()=>{if(cleaning)return;cleaning=true;try{await cleanMcpStaging();}catch{console.error("MCP staging cleanup failed");}finally{cleaning=false;}};
  void clean();const timer=setInterval(()=>void clean(),60000);timer.unref();return ()=>clearInterval(timer);
}

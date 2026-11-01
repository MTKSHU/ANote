import {expect,request as playwrightRequest,type APIRequestContext} from "@playwright/test";
import {randomUUID,randomBytes,createHash} from "node:crypto";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {api,admin} from "./helpers";
export const origin=process.env.BASE_URL||"http://anote.internal:3000";
export const scopes="notes:read notes:write assets:read assets:write";
export async function person(request:APIRequestContext){const root=await admin(request),username="mcp-"+randomUUID().slice(0,8),password="Mcp-test-123!";await api(request,"POST","users",{username,password,name:"MCP 研究者"},root);return {...await api(request,"POST","auth/login",{username,password}),username,password};}
export async function register(request:APIRequestContext,name="MCP 测试客户端",confidential=false){const response=await request.post("/register",{data:{client_name:name,redirect_uris:["http://127.0.0.1:33418/callback"],token_endpoint_auth_method:confidential?"client_secret_post":"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]}});expect(response.status(),await response.text()).toBe(201);return response.json();}
export function authorization(client:any,scope=scopes){const verifier=randomBytes(32).toString("base64url"),state=randomUUID();const query=new URLSearchParams({response_type:"code",client_id:client.client_id,redirect_uri:client.redirect_uris[0],code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",resource:origin+"/mcp",scope,state});return {verifier,state,url:origin+"/authorize?"+query};}
export async function grant(request:APIRequestContext,account:any,scope=scopes,name="MCP 测试客户端"){
  const context=await playwrightRequest.newContext({baseURL:origin}),client=await register(context,name),flow=authorization(client,scope);
  const start=await context.get(flow.url,{maxRedirects:0});expect(start.status(),await start.text()).toBe(303);const id=new URL(start.headers().location).searchParams.get("mcp_authorize")!;
  await api(context,"GET","me/integrations/authorization/"+id,undefined,account);
  const decision=await api(context,"POST","me/integrations/authorization/"+id,{allow:true},account),callback=new URL(decision.redirect_uri);expect(callback.searchParams.get("state")).toBe(flow.state);
  const form={grant_type:"authorization_code",client_id:client.client_id,code:callback.searchParams.get("code")!,code_verifier:flow.verifier,redirect_uri:client.redirect_uris[0],resource:origin+"/mcp"};
  const response=await context.post("/token",{form});expect(response.status(),await response.text()).toBe(200);const tokens=await response.json();
  return {context,client,flow,form,tokens,close:()=>context.dispose()};
}
export async function connect(token:string,name="verification"){const client=new Client({name,version:"1.0.0"});await client.connect(new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{requestInit:{headers:{Authorization:"Bearer "+token}}}));return client;}
export async function call(client:Client,name:string,args:any={},status?:number){const result=await client.callTool({name,arguments:args});if(status){expect(result.isError).toBe(true);const error=JSON.parse((result.content as any[])[0].text);expect(error.status,error.error).toBe(status);return error;}if(result.isError)throw new Error((result.content as any[])[0].text);return result.structuredContent as any;}
export async function fixture(request:APIRequestContext){const owner=await person(request),peer=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"MCP 私人资料"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"MCP 实验记录"},owner);return {owner,peer,book,note};}
export async function upload(client:Client,request:APIRequestContext,bytes:Buffer,target:any,name="sample.png"){
  const hash=createHash("sha256").update(bytes).digest("hex"),start=await call(client,"begin_upload",{...target,filename:name,bytes:bytes.length,sha256:hash});
  const response=await request.put(start.upload_url,{headers:{"Content-Type":"application/octet-stream","Upload-Offset":"0","Upload-Sha256":hash},data:bytes});expect(response.status(),await response.text()).toBe(200);
  const duplicate=await request.put(start.upload_url,{headers:{"Content-Type":"application/octet-stream","Upload-Offset":"0","Upload-Sha256":hash},data:bytes});expect(duplicate.status()).toBe(200);
  const done=await call(client,"complete_upload",{upload_id:start.upload_id});expect(done.status).toBe("ready");return done;
}

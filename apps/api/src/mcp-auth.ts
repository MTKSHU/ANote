import {randomBytes,randomUUID,timingSafeEqual} from "node:crypto";
import {Controller,Get,Post,Delete,Req,Param,Body,Header} from "@nestjs/common";
import type {Request,Response} from "express";
import type {OAuthServerProvider,AuthorizationParams} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {OAuthClientInformationFull,OAuthTokenRevocationRequest} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {AuthInfo} from "@modelcontextprotocol/sdk/server/auth/types.js";
import {InvalidGrantError,InvalidTokenError,InvalidScopeError,InvalidRequestError,InvalidClientMetadataError} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {db,digest,transaction} from "./database.js";
import {user,publicUser,type User} from "./auth.js";
import {platformConfig,encrypt,decrypt} from "./platform.js";
import {identifier,fail,text} from "./errors.js";

export const MCP_SCOPES=["notes:read","notes:write","assets:read","assets:write"];
const PERSONAL_CLIENT_PREFIX="personal-token:",PERSONAL_TOKEN_PREFIX="anote_mcp_";
const isPersonalClient=(id:string)=>id.startsWith(PERSONAL_CLIENT_PREFIX);
export const mcpOrigin=()=>new URL(platformConfig().public_origin).origin;
export const mcpResource=()=>mcpOrigin()+"/mcp";
export type McpIdentity={account:User;grantId:string;clientId:string;clientName:string;scopes:string[]};
const random=()=>randomBytes(32).toString("base64url");
function scopesOf(scopes:string[]=MCP_SCOPES){if(!scopes.length||scopes.some(s=>!MCP_SCOPES.includes(s)))throw new InvalidScopeError("Unsupported SimpleNote scope");return [...new Set(scopes)];}
function checkResource(resource?:URL){if(resource?.href!==mcpResource())throw new InvalidRequestError("resource must identify this SimpleNote MCP endpoint");}
const cookie=(req:Request,name:string)=>(req.headers.cookie||"").split(";").map(p=>p.trim()).find(p=>p.startsWith(name+"="))?.slice(name.length+1)||"";

export class McpOAuthProvider implements OAuthServerProvider {
  clientsStore={
    getClient:async(id:string):Promise<OAuthClientInformationFull|undefined>=>{
      // Personal tokens are MCP-only grants, never OAuth clients that can
      // exchange authorization codes or mint refresh tokens at /token.
      if(isPersonalClient(id))return undefined;
      const row=(await db.query("SELECT * FROM mcp_clients WHERE id=$1",[id])).rows[0];
      if(!row)return undefined;
      return {...row.metadata,...(row.secret_encrypted?{client_secret:decrypt(row.secret_encrypted)}:{})};
    },
    registerClient:async(input:Omit<OAuthClientInformationFull,"client_id"|"client_id_issued_at">):Promise<OAuthClientInformationFull>=>{
      if(JSON.stringify(input).length>65536)throw new InvalidClientMetadataError("Client metadata exceeds 64 KiB");
      if(!input.redirect_uris.length||input.redirect_uris.length>10)throw new InvalidClientMetadataError("Register 1–10 redirect URIs");
      for(const value of input.redirect_uris){const u=new URL(value);if(value.length>2048||u.username||u.password||u.hash||!(u.protocol==="https:"||(u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname))))throw new InvalidClientMetadataError("Redirect URIs require HTTPS or HTTP loopback and at most 2048 characters");}
      if(!["none","client_secret_post"].includes(input.token_endpoint_auth_method||"client_secret_post"))throw new InvalidClientMetadataError("Unsupported client authentication method");
      if(input.grant_types?.some(g=>!["authorization_code","refresh_token"].includes(g)))throw new InvalidClientMetadataError("Only authorization-code and refresh-token grants are supported");
      const {client_secret,...metadata}=input;
      const client={...metadata,client_id:randomUUID(),client_id_issued_at:Math.floor(Date.now()/1000),...(client_secret?{client_secret}:{}),client_name:String(input.client_name||"MCP 应用").slice(0,120)};
      const {client_secret:secret,...stored}=client;
      await db.query("INSERT INTO mcp_clients(id,metadata,secret_encrypted) VALUES($1,$2,$3)",[client.client_id,stored,secret?encrypt(secret):""]);
      return client;
    }
  };
  async authorize(client:OAuthClientInformationFull,params:AuthorizationParams,res:Response){
    checkResource(params.resource);const scopes=scopesOf(params.scopes?.length?params.scopes:MCP_SCOPES),id=randomUUID(),browser=random();
    await db.query("INSERT INTO mcp_authorizations(id,client_id,params,browser_hash) VALUES($1,$2,$3,$4)",[id,client.client_id,{...params,scopes,resource:mcpResource()},digest(browser)]);
    res.cookie("simplenote_mcp_request",id+"."+browser,{httpOnly:true,sameSite:"lax",secure:mcpOrigin().startsWith("https:"),path:"/",maxAge:10*60000});
    res.setHeader("Referrer-Policy","no-referrer");res.redirect(303,mcpOrigin()+"/?mcp_authorize="+id);
  }
  async challengeForAuthorizationCode(client:OAuthClientInformationFull,code:string){
    const row=(await db.query("SELECT c.challenge FROM mcp_codes c JOIN mcp_grants g ON g.id=c.grant_id WHERE c.hash=$1 AND g.client_id=$2 AND c.used_at IS NULL AND c.expires_at>now() AND g.revoked_at IS NULL",[digest(code),client.client_id])).rows[0];
    if(!row)throw new InvalidGrantError("Authorization code is invalid or expired");return row.challenge;
  }
  async issue(client:any,grant:any,scopes:string[]){
    const access=random(),refresh=random();
    await client.query("INSERT INTO mcp_tokens(hash,grant_id,kind,scopes,expires_at) VALUES($1,$3,'access',$4,least(now()+interval '1 hour',$5)),($2,$3,'refresh',$4,$5)",[digest(access),digest(refresh),grant.id,scopes,grant.expires_at]);
    return {access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:Math.min(3600,Math.floor((new Date(grant.expires_at).getTime()-Date.now())/1000)),scope:scopes.join(" ")};
  }
  async exchangeAuthorizationCode(client:OAuthClientInformationFull,code:string,verifier?:string,redirect?:string,resource?:URL){
    checkResource(resource);
    return transaction(async sql=>{
      const row=(await sql.query("SELECT c.*,g.id AS grant,g.client_id,g.scopes,g.expires_at AS grant_expires,g.resource,u.active,g.revoked_at FROM mcp_codes c JOIN mcp_grants g ON g.id=c.grant_id JOIN users u ON u.id=g.user_id WHERE c.hash=$1 FOR UPDATE OF c,g",[digest(code)])).rows[0];
      // The SDK validates S256 against challengeForAuthorizationCode before calling here.
      if(!row||!row.active||row.revoked_at||row.used_at||row.client_id!==client.client_id||new Date(row.expires_at).getTime()<=Date.now()||new Date(row.grant_expires).getTime()<=Date.now()||row.resource!==mcpResource()||redirect!==row.redirect_uri)throw new InvalidGrantError("Authorization code validation failed");
      await sql.query("UPDATE mcp_codes SET used_at=now() WHERE hash=$1",[digest(code)]);
      return this.issue(sql,{id:row.grant,expires_at:row.grant_expires},row.scopes);
    });
  }
  async exchangeRefreshToken(client:OAuthClientInformationFull,token:string,scopes?:string[],resource?:URL){
    checkResource(resource);
    const result=await transaction(async sql=>{
      const row=(await sql.query("SELECT t.*,g.client_id,g.resource,g.revoked_at,g.expires_at AS grant_expires,u.active FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.user_id WHERE t.hash=$1 AND t.kind='refresh' FOR UPDATE OF t,g",[digest(token)])).rows[0];
      if(!row||!row.active||row.revoked_at||row.client_id!==client.client_id||row.resource!==mcpResource()||new Date(row.expires_at).getTime()<=Date.now()||new Date(row.grant_expires).getTime()<=Date.now())throw new InvalidGrantError("Refresh token is invalid or expired");
      if(row.consumed_at){
        // Commit revocation before reporting replay, so the newer token family
        // cannot remain usable when an old refresh token has been reused.
        await sql.query("UPDATE mcp_grants SET revoked_at=now() WHERE id=$1",[row.grant_id]);return null;
      }
      const requested=scopesOf(scopes||row.scopes);if(requested.some(s=>!row.scopes.includes(s)))throw new InvalidScopeError("Scopes cannot be widened");
      await sql.query("UPDATE mcp_tokens SET consumed_at=now() WHERE hash=$1",[digest(token)]);
      return this.issue(sql,{id:row.grant_id,expires_at:row.grant_expires},requested);
    });
    if(!result)throw new InvalidGrantError("Refresh token was reused; reconnect the application");return result;
  }
  async verifyAccessToken(token:string):Promise<AuthInfo>{
    if(!/^(?:anote_mcp_)?[\w-]{43}$/.test(token))throw new InvalidTokenError("Invalid access token");
    const row=(await db.query("SELECT t.scopes,t.expires_at,g.id AS grant_id,g.user_id,g.client_id,g.resource,c.metadata->>'client_name' AS client_name FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.user_id JOIN mcp_clients c ON c.id=g.client_id WHERE t.hash=$1 AND t.kind='access' AND t.consumed_at IS NULL AND t.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now() AND u.active",[digest(token)])).rows[0];
    if(!row||row.resource!==mcpResource())throw new InvalidTokenError("Access has expired or was revoked");
    await db.query("UPDATE mcp_grants SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",[row.grant_id]);
    return {token,clientId:row.client_id,scopes:row.scopes,expiresAt:Math.floor(new Date(row.expires_at).getTime()/1000),resource:new URL(row.resource),extra:{grantId:row.grant_id,userId:row.user_id,clientName:row.client_name}};
  }
  async revokeToken(client:OAuthClientInformationFull,input:OAuthTokenRevocationRequest){
    await db.query("UPDATE mcp_grants SET revoked_at=coalesce(revoked_at,now()) WHERE client_id=$1 AND id IN (SELECT grant_id FROM mcp_tokens WHERE hash=$2)",[client.client_id,digest(input.token)]);
  }
}
export const mcpOAuth=new McpOAuthProvider();
export async function mcpIdentity(auth:AuthInfo):Promise<McpIdentity>{
  // Revalidate even for long-lived transports and staged-file requests.
  const checked=await mcpOAuth.verifyAccessToken(auth.token),row=(await db.query("SELECT * FROM users WHERE id=$1 AND active",[checked.extra!.userId])).rows[0];
  if(!row)throw new InvalidTokenError("Account unavailable");
  return {account:publicUser(row),grantId:String(checked.extra!.grantId),clientId:checked.clientId,clientName:String(checked.extra!.clientName),scopes:checked.scopes};
}
export function requireScope(identity:McpIdentity,scope:string){if(!identity.scopes.includes(scope))fail(403,"连接未授权此操作："+scope);}
async function pending(req:Request,id:string){
  const value=cookie(req,"simplenote_mcp_request"),[requestId,browser]=value.split(".");
  const row=(await db.query("SELECT a.*,c.metadata FROM mcp_authorizations a JOIN mcp_clients c ON c.id=a.client_id WHERE a.id=$1 AND a.expires_at>now() AND a.consumed_at IS NULL",[identifier(id)])).rows[0];
  if(!row||requestId!==id||!browser||!timingSafeEqual(Buffer.from(row.browser_hash),Buffer.from(digest(browser))))fail(400,"授权请求已过期，请从 AI 工具重新连接");return row;
}
@Controller("api/me/integrations")
export class McpConnectionsController {
  @Get() async list(@Req() req:Request){
    const account=await user(req);
    // Active personal tokens are capped at 20 and must always remain visible
    // for revocation, even after hundreds of newer, revoked connections.
    const connections=(await db.query(`
      SELECT g.id,g.scopes,g.created_at,g.last_used_at,g.expires_at,g.revoked_at,
        c.metadata->>'client_name' AS client_name,
        CASE WHEN g.client_id LIKE 'personal-token:%' THEN 'personal_token' ELSE 'oauth' END AS authentication_type
      FROM mcp_grants g JOIN mcp_clients c ON c.id=g.client_id WHERE g.user_id=$1
      ORDER BY CASE WHEN g.revoked_at IS NULL AND g.expires_at>now()
        THEN CASE WHEN g.client_id LIKE 'personal-token:%' THEN 0 ELSE 1 END ELSE 2 END,
        g.created_at DESC,g.id LIMIT 100`,[account.id])).rows;
    return {endpoint:mcpResource(),connections};
  }
  @Post("tokens") @Header("Cache-Control","no-store") async createToken(@Req() req:Request,@Body() input:any){
    const account=await user(req),name=text(input?.name,"令牌名称",80);
    const days=input?.expires_in_days??30;
    if(!Number.isInteger(days)||days<1||days>90)fail(400,"令牌有效期应为 1–90 天");
    const requested=input?.scopes??["notes:read","assets:read"];
    if(!Array.isArray(requested)||!requested.length||requested.length>4||requested.some(scope=>typeof scope!=="string"||!MCP_SCOPES.includes(scope)))fail(400,"请选择有效的 MCP 令牌权限");
    const scopes=[...new Set<string>(requested)],id=randomUUID(),clientId=PERSONAL_CLIENT_PREFIX+randomUUID(),token=PERSONAL_TOKEN_PREFIX+random();
    return transaction(async sql=>{
      await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))",["mcp-personal-token:"+account.id]);
      const count=(await sql.query("SELECT count(*)::integer AS count FROM mcp_grants WHERE user_id=$1 AND client_id LIKE 'personal-token:%' AND revoked_at IS NULL AND expires_at>now()",[account.id])).rows[0].count;
      if(count>=20)fail(400,"最多保留 20 个有效 MCP 令牌，请先撤销不再使用的令牌");
      // Reuse the existing grant/token tables so OAuth grants survive this
      // feature without a schema migration or any token rotation.
      await sql.query("INSERT INTO mcp_clients(id,metadata) VALUES($1,$2)",[clientId,{client_id:clientId,client_name:name,redirect_uris:[],grant_types:[],response_types:[],token_endpoint_auth_method:"none"}]);
      const grant=(await sql.query("INSERT INTO mcp_grants(id,user_id,client_id,resource,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6::integer*interval '1 day') RETURNING expires_at",[id,account.id,clientId,mcpResource(),scopes,days])).rows[0];
      await sql.query("INSERT INTO mcp_tokens(hash,grant_id,kind,scopes,expires_at) VALUES($1,$2,'access',$3,$4)",[digest(token),id,scopes,grant.expires_at]);
      await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'integration.token.create',$2,$3)",[account.id,id,{name,scopes,expires_at:grant.expires_at}]);
      return {id,token,name,scopes,expires_at:grant.expires_at};
    });
  }
  @Delete(":id") async revoke(@Req() req:Request,@Param("id") id:string){const account=await user(req);await db.query("UPDATE mcp_grants SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND user_id=$2",[identifier(id),account.id]);return {ok:true};}
  @Get("pending") async current(@Req() req:Request){await user(req);const id=cookie(req,"simplenote_mcp_request").split(".")[0];if(!id)return {id:null};try{await pending(req,id);return {id};}catch{return {id:null};}}
  @Get("authorization/:id") async details(@Req() req:Request,@Param("id") id:string){await user(req);const row=await pending(req,id);return {id:row.id,client_name:row.metadata.client_name,redirect_uri:row.params.redirectUri,scopes:row.params.scopes};}
  @Post("authorization/:id") async consent(@Req() req:Request,@Param("id") id:string,@Body() input:any){
    const account=await user(req),request=await pending(req,id);if(typeof input?.allow!=="boolean")fail(400,"请选择允许或取消");
    const code=random(),destination=new URL(request.params.redirectUri);
    await transaction(async sql=>{
      const consumed=await sql.query("UPDATE mcp_authorizations SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING id",[id]);if(!consumed.rowCount)fail(409,"此授权请求已使用，请重新连接");
      if(input.allow){
        const grant=randomUUID();await sql.query("INSERT INTO mcp_grants(id,user_id,client_id,resource,scopes) VALUES($1,$2,$3,$4,$5)",[grant,account.id,request.client_id,mcpResource(),request.params.scopes]);
        await sql.query("INSERT INTO mcp_codes(hash,grant_id,challenge,redirect_uri) VALUES($1,$2,$3,$4)",[digest(code),grant,request.params.codeChallenge,request.params.redirectUri]);
        await sql.query("INSERT INTO audit_events(actor,action,target) VALUES($1,'integration.authorize',$2)",[account.id,grant]);
      }
    });
    destination.searchParams.set(input.allow?"code":"error",input.allow?code:"access_denied");
    if(request.params.state)destination.searchParams.set("state",request.params.state);destination.searchParams.set("iss",mcpOrigin()+"/");
    return {redirect_uri:destination.href};
  }
}

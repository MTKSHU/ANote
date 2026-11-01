import fs from "node:fs/promises";
import path from "node:path";
import {createWriteStream} from "node:fs";
import {randomUUID,randomBytes,createHash} from "node:crypto";
import {lookup} from "node:dns/promises";
import https from "node:https";
import {BlockList,isIP} from "node:net";
import {Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import type {Request,Response} from "express";
import type {PoolClient} from "pg";
import {db,digest,transaction} from "./database.js";
import {publicUser,documentRole,spaceRole} from "./auth.js";
import {assetFor,localAssetPath} from "./assets.js";
import {mcpOrigin,mcpResource,requireScope,type McpIdentity} from "./mcp-auth.js";
import {storagePath,CHUNK_BYTES,MAX_ASSET_BYTES,receiveChunk,describeFile,fileHash} from "./storage.js";
import {fail,identifier,text} from "./errors.js";

const filename=(value:any)=>{const name=text(value,"文件名",240);if(/[\x00-\x1f/\\]/.test(name)||name==="."||name==="..")fail(400,"文件名无效");return name;};
const sha=(value:any)=>{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))fail(400,"SHA-256 无效");return value;};
export const stagePath=(id:string)=>storagePath("uploads","mcp-"+identifier(id)+".part");
export const originalKey=(id:string)=>"mcp-"+identifier(id)+".bin";
const view=(row:any)=>({upload_id:row.id,filename:row.filename,bytes:Number(row.bytes),offset:Number(row.offset_bytes),hash:row.hash,status:row.status,kind:row.kind,mime:row.mime,error:row.error,asset_id:row.asset_id,chunk_bytes:CHUNK_BYTES});
export async function uploadTarget(identity:McpIdentity,input:any){
  requireScope(identity,"notes:write");requireScope(identity,"assets:write");
  if(input.note_id){const doc=await documentRole(identity.account,identifier(input.note_id),"edit");if(input.library_id&&input.library_id!==doc.space_id)fail(400,"笔记不属于目标知识库");return {space:doc.space_id,doc:doc.id};}
  const space=identifier(input.library_id);await spaceRole(identity.account,space,"create");return {space,doc:null};
}
export async function staged(identity:McpIdentity,id:string,space?:string,doc?:string|null){
  const row=(await db.query("SELECT * FROM mcp_uploads WHERE id=$1 AND grant_id=$2 AND user_id=$3 AND expires_at>now()",[identifier(id),identity.grantId,identity.account.id])).rows[0];
  if(!row)fail(404,"暂存文件不存在或已过期");
  if(space&&row.space_id!==space||doc!==undefined&&row.doc_id!==doc)fail(403,"暂存文件不属于此笔记目标");
  await uploadTarget(identity,{note_id:row.doc_id,library_id:row.space_id});return row;
}
export async function beginUpload(identity:McpIdentity,input:any){
  const target=await uploadTarget(identity,input),name=filename(input.filename),hash=sha(input.sha256),bytes=input.bytes;
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_ASSET_BYTES)fail(413,"文件超过平台上传上限");
  const row=await transaction(async sql=>{
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))",[identity.grantId+hash+(target.doc||target.space)]);
    const old=(await sql.query("SELECT * FROM mcp_uploads WHERE grant_id=$1 AND space_id=$2 AND doc_id IS NOT DISTINCT FROM $3 AND expected_hash=$4 AND bytes=$5 AND filename=$6 AND status IN ('uploading','ready') AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[identity.grantId,target.space,target.doc,hash,bytes,name])).rows[0];
    if(old)return old;
    if(Number((await sql.query("SELECT count(*) FROM mcp_uploads WHERE grant_id=$1 AND status IN ('uploading','fetching','ready') AND expires_at>now()",[identity.grantId])).rows[0].count)>=24)fail(429,"待处理附件过多，请先完成或取消上传");
    return (await sql.query("INSERT INTO mcp_uploads(id,grant_id,user_id,space_id,doc_id,filename,bytes,expected_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'uploading') RETURNING *",[randomUUID(),identity.grantId,identity.account.id,target.space,target.doc,name,bytes,hash])).rows[0];
  });
  const ticket=randomBytes(32).toString("base64url");await db.query("UPDATE mcp_uploads SET ticket_hash=$2,ticket_expires_at=now()+interval '30 minutes' WHERE id=$1",[row.id,digest(ticket)]);
  return {...view(row),upload_url:mcpOrigin()+"/mcp-upload/"+row.id+"?ticket="+ticket,instructions:"用本机文件传输工具分块 PUT 二进制数据；Content-Type: application/octet-stream，Upload-Offset 为字节偏移，Upload-Sha256 为本块 SHA-256。不要把文件正文或永久凭据放入聊天。全部传完调用 complete_upload；上传地址失效可再次 begin_upload 续传。"};
}
let transfers=0;
async function transfer<T>(fn:()=>Promise<T>){if(transfers>=4)fail(429,"正在处理多个附件，请稍后重试");transfers++;try{return await fn();}finally{transfers--;}}
export async function receiveMcpChunk(req:Request,res:Response){
  const id=identifier(req.params.id),ticket=String(req.query.ticket||"");
  if(!/^[\w-]{43}$/.test(ticket))fail(401,"上传地址无效");
  const row=(await db.query("SELECT u.*,g.client_id,g.scopes,g.resource,c.metadata->>'client_name' AS client_name,to_jsonb(a) AS account FROM mcp_uploads u JOIN mcp_grants g ON g.id=u.grant_id JOIN users a ON a.id=g.user_id JOIN mcp_clients c ON c.id=g.client_id WHERE u.id=$1 AND u.ticket_hash=$2 AND u.ticket_expires_at>now() AND u.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now() AND a.active",[id,digest(ticket)])).rows[0];
  if(!row||row.resource!==mcpResource())fail(401,"上传地址已过期或连接已撤销");
  const identity:McpIdentity={account:publicUser(row.account),grantId:row.grant_id,clientId:row.client_id,clientName:row.client_name,scopes:row.scopes};
  await uploadTarget(identity,{note_id:row.doc_id,library_id:row.space_id});
  const offset=Number(req.headers["upload-offset"]),bytes=Number(req.headers["content-length"]),hash=sha(req.headers["upload-sha256"]);
  if(!req.is("application/octet-stream")||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(bytes)||bytes<1||bytes>CHUNK_BYTES||offset+bytes>Number(row.bytes))fail(400,"分块长度、偏移或类型无效");
  return transfer(async()=>{
    const piece=storagePath("uploads","mcp-chunk-"+randomUUID()+".part");
    try{
      await receiveChunk(req,piece,bytes,hash);
      const result=await transaction(async sql=>{
        const grant=(await sql.query("SELECT id FROM mcp_grants WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR SHARE",[identity.grantId])).rowCount;if(!grant)fail(401,"连接已撤销");
        const current=(await sql.query("SELECT * FROM mcp_uploads WHERE id=$1 FOR UPDATE",[id])).rows[0];
        if(current.status!=="uploading")fail(409,"上传已结束");
        if(Number(current.offset_bytes)!==offset){const chunk=(await sql.query("SELECT * FROM mcp_upload_chunks WHERE upload_id=$1 AND offset_bytes=$2",[id,offset])).rows[0];if(chunk&&Number(chunk.bytes)===bytes&&chunk.hash===hash)return view(current);fail(409,"上传偏移已变化，请查询进度后重试");}
        const target=stagePath(id),handle=await fs.open(target,Number(current.offset_bytes)?"r+":"w+");
        try{await handle.truncate(offset);const data=await fs.readFile(piece);let written=0;while(written<data.length)written+=(await handle.write(data,written,data.length-written,offset+written)).bytesWritten;await handle.sync();}finally{await handle.close();}
        await sql.query("INSERT INTO mcp_upload_chunks(upload_id,offset_bytes,bytes,hash) VALUES($1,$2,$3,$4)",[id,offset,bytes,hash]);
        return view((await sql.query("UPDATE mcp_uploads SET offset_bytes=offset_bytes+$2 WHERE id=$1 RETURNING *",[id,bytes])).rows[0]);
      });res.json(result);
    }finally{await fs.rm(piece,{force:true});}
  });
}
export async function completeUpload(identity:McpIdentity,id:string){
  await staged(identity,id);
  return transfer(()=>transaction(async sql=>{
    const row=(await sql.query("SELECT * FROM mcp_uploads WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(["ready","attached"].includes(row.status))return view(row);
    if(row.status!=="uploading"||Number(row.offset_bytes)!==Number(row.bytes))fail(409,"文件尚未上传完整");
    if(await fileHash(stagePath(id))!==row.expected_hash)fail(422,"文件校验不匹配，请取消后重新上传");
    const description=await describeFile(stagePath(id),row.filename,Number(row.bytes));
    return view((await sql.query("UPDATE mcp_uploads SET status='ready',hash=expected_hash,kind=$2,mime=$3,metadata=$4,ticket_hash=NULL WHERE id=$1 RETURNING *",[id,description.kind,description.mime,description.metadata])).rows[0]);
  }));
}
export async function uploadStatus(identity:McpIdentity,id:string){return view(await staged(identity,id));}
export async function cancelUpload(identity:McpIdentity,id:string){
  await staged(identity,id);
  await transaction(async sql=>{
    const row=(await sql.query("SELECT status FROM mcp_uploads WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!row)fail(404,"暂存文件已清理");if(row.status==="attached")fail(409,"附件已正式引用，请在笔记中修改引用");
    await sql.query("UPDATE mcp_uploads SET status='cancelled',ticket_hash=NULL WHERE id=$1",[id]);
  });
  downloads.get(id)?.abort();await fs.rm(stagePath(id),{force:true});return {cancelled:true};
}
export async function promoteUpload(sql:PoolClient,identity:McpIdentity,id:string,docId:string,space:string,sourceDoc:string|null){
  const row=(await sql.query("SELECT * FROM mcp_uploads WHERE id=$1 AND grant_id=$2 AND user_id=$3 FOR UPDATE",[id,identity.grantId,identity.account.id])).rows[0];
  if(!row||row.space_id!==space||row.doc_id!==sourceDoc||row.status!=="ready"||new Date(row.expires_at).getTime()<=Date.now())fail(409,"暂存附件已变化，请重新准备变更");
  const original=storagePath("originals",originalKey(id));
  if(await fs.stat(original).catch(()=>null)){if(await fileHash(original)!==row.hash)fail(409,"附件文件状态异常");}
  else {
    // uploads and originals can be different TrueNAS datasets. Keep staging until
    // commit so a failed multi-file transaction remains safely retryable.
    const temporary=storagePath("originals",originalKey(id)+".copy");
    try{
      await fs.copyFile(stagePath(id),temporary);
      const file=await fs.open(temporary,"r+");try{await file.sync();}finally{await file.close();}
      await fs.rename(temporary,original);
      const directory=await fs.open(path.dirname(original),"r");try{await directory.sync();}finally{await directory.close();}
    }finally{await fs.rm(temporary,{force:true});}
  }
  await sql.query("INSERT INTO assets(id,space_id,created_by,filename,title,mime,bytes,hash,storage_key,kind,metadata,status,owner_doc_id) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,'ready',$11)",[id,space,identity.account.id,row.filename,row.mime,row.bytes,row.hash,originalKey(id),row.kind,row.metadata,docId]);
  await sql.query("UPDATE mcp_uploads SET status='attached',asset_id=$1 WHERE id=$1",[id]);
  if(["image","video","audio"].includes(row.kind))await sql.query("INSERT INTO jobs(id,kind,asset_id) VALUES($1,'probe',$2)",[randomUUID(),id]);
}

// A model-supplied file URL never gains access to NAS, loopback or cloud metadata.
const blocked=new BlockList();for(const [ip,prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const)blocked.addSubnet(ip,prefix);
const globalV6=new BlockList();globalV6.addSubnet("2000::",3,"ipv6");blocked.addSubnet("2001:db8::",32,"ipv6");blocked.addSubnet("2002::",16,"ipv6");
export async function publicFileResponse(source:string,redirects=0,signal?:AbortSignal):Promise<import("node:http").IncomingMessage>{
  let url:URL;try{url=new URL(source);}catch{fail(400,"文件下载地址无效");}
  if(url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443")||redirects>3)fail(400,"文件只能从公网 HTTPS 下载");
  const addresses=await lookup(url.hostname.replace(/^\[|\]$/g,""),{all:true});
  if(!addresses.length||addresses.some(({address,family})=>family===4?blocked.check(address):!globalV6.check(address,"ipv6")||blocked.check(address,"ipv6")))fail(400,"文件地址指向了受限网络");
  const chosen=addresses[0];
  const response=await new Promise<import("node:http").IncomingMessage>((resolve,reject)=>{
    const request=https.get(url,{signal,lookup:((_host:any,options:any,callback:any)=>{if(options?.all)callback(null,[chosen]);else callback(null,chosen.address,chosen.family);}) as any,headers:{Accept:"application/octet-stream","Accept-Encoding":"identity"}},resolve);
    request.setTimeout(30000,()=>request.destroy(new Error("文件下载超时")));request.on("error",reject);
  });
  if([301,302,303,307,308].includes(response.statusCode||0)&&response.headers.location){response.destroy();return publicFileResponse(new URL(response.headers.location,url).href,redirects+1,signal);}
  if(response.statusCode!==200){response.destroy();fail(400,"文件下载失败，请重新提供文件");}return response;
}
const fetching=new Set<string>();
const downloads=new Map<string,AbortController>();
export async function importChatFile(identity:McpIdentity,input:any){
  const target=await uploadTarget(identity,input),file=input.file;
  if(!file||typeof file.download_url!=="string"||typeof file.file_id!=="string"||file.download_url.length>10000||file.file_id.length>240)fail(400,"请提供 ChatGPT 授权的文件参数");
  const name=filename(file.file_name||"attachment.bin"),id=randomUUID();
  if(transfers>=4)fail(429,"附件传输已满，请稍后重试");
  if(Number((await db.query("SELECT count(*) FROM mcp_uploads WHERE grant_id=$1 AND status IN ('uploading','fetching','ready') AND expires_at>now()",[identity.grantId])).rows[0].count)>=24)fail(429,"待处理附件过多");
  await db.query("INSERT INTO mcp_uploads(id,grant_id,user_id,space_id,doc_id,filename,status) VALUES($1,$2,$3,$4,$5,$6,'fetching')",[id,identity.grantId,identity.account.id,target.space,target.doc,name]);
  fetching.add(id);
  void transfer(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5*60000);downloads.set(id,controller);
    try{
      const response=await publicFileResponse(file.download_url,0,controller.signal);let bytes=0;const hash=createHash("sha256");
      await pipeline(response,new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>MAX_ASSET_BYTES)return callback(new Error("附件超过平台大小限制"));hash.update(chunk);callback(null,chunk);}}),createWriteStream(stagePath(id),{flags:"wx",mode:0o600}),{signal:controller.signal});
      if(!bytes)throw new Error("文件为空");
      const description=await describeFile(stagePath(id),name,bytes);
      const updated=await db.query("UPDATE mcp_uploads SET status='ready',bytes=$2,offset_bytes=$2,hash=$3,kind=$4,mime=$5,metadata=$6 WHERE id=$1 AND status='fetching'",[id,bytes,hash.digest("hex"),description.kind,description.mime,description.metadata]);if(!updated.rowCount)await fs.rm(stagePath(id),{force:true});
    }catch(error){await fs.rm(stagePath(id),{force:true});await db.query("UPDATE mcp_uploads SET status='failed',error=$2 WHERE id=$1 AND status='fetching'",[id,(error as any).getStatus?"下载地址不可用或不符合要求":"文件下载失败，请重新提供文件"]);}finally{clearTimeout(timer);downloads.delete(id);fetching.delete(id);}
  }).catch(()=>{});
  return {upload_id:id,status:"fetching",next:"调用 upload_status 查看传输结果，ready 后将 upload_id 作为 assetId 引用。"};
}
export async function cleanMcpStaging(){
  await db.query("UPDATE mcp_uploads SET status='failed',error='传输中断，请重新提供文件' WHERE status='fetching' AND created_at<now()-interval '10 minutes' AND NOT(id=ANY($1::text[]))",[[...fetching]]);
  const attached=(await db.query("SELECT id FROM mcp_uploads WHERE status='attached' AND staging_cleaned_at IS NULL LIMIT 100")).rows;
  for(const row of attached){await fs.rm(stagePath(row.id),{force:true});await db.query("UPDATE mcp_uploads SET staging_cleaned_at=now(),ticket_hash=NULL WHERE id=$1",[row.id]);}
  const expired=(await db.query("SELECT id FROM mcp_uploads WHERE status<>'attached' AND (expires_at<now() OR status='cancelled') AND NOT(id=ANY($1::text[])) LIMIT 100",[[...fetching]])).rows;
  for(const row of expired){await fs.rm(stagePath(row.id),{force:true});if(!(await db.query("SELECT 1 FROM assets WHERE id=$1",[row.id])).rowCount)await fs.rm(storagePath("originals",originalKey(row.id)),{force:true});await db.query("DELETE FROM mcp_uploads WHERE id=$1 AND status<>'attached'",[row.id]);}
  await db.query("DELETE FROM mcp_changes WHERE expires_at<now()-interval '1 day' AND applied_at IS NULL");
  await db.query("DELETE FROM mcp_tokens WHERE expires_at<now()-interval '1 day'");
  await db.query("DELETE FROM mcp_codes WHERE expires_at<now()-interval '1 day'");
  await db.query("DELETE FROM mcp_authorizations WHERE expires_at<now()-interval '1 day'");
}
export async function readAsset(identity:McpIdentity,id:string){
  requireScope(identity,"assets:read");const asset=await assetFor(identity.account,identifier(id));
  const info={id:asset.id,filename:asset.filename,kind:asset.kind,mime:asset.mime,bytes:Number(asset.bytes),hash:asset.hash};
  if(["image/png","image/jpeg","image/webp","image/gif"].includes(asset.mime)&&Number(asset.bytes)<=4*1024*1024)return {info,image:{type:"image",mimeType:asset.mime,data:(await fs.readFile(storagePath("originals",asset.storage_key))).toString("base64")}};
  if((asset.mime.startsWith("text/")||asset.mime==="application/json")&&Number(asset.bytes)<=1024*1024)return {info,text:await fs.readFile(storagePath("originals",asset.storage_key),"utf8")};
  return {info,url:mcpOrigin()+"/api/assets/"+asset.id+"/file",notice:"大附件请在已登录平台的浏览器中打开；MCP 令牌不作为平台网页会话使用。"};
}

import {Body,Controller,Delete,Get,Inject,Param,Post,Patch,Req,Res} from "@nestjs/common";
import type {Request,Response} from "express";
import {randomBytes,randomUUID} from "node:crypto";
import {db,digest,transaction} from "./database.js";
import {user,spaceRole,type User} from "./auth.js";
import {Documents} from "./documents.js";
import {fail,identifier,text} from "./errors.js";
import {platformConfig} from "./platform.js";
import {publicAssets,publicSnapshot} from "./sharing.js";
import {sendFile,storagePath,normalizeSvgAsset} from "./storage.js";
import {sealShareToken,watermarkSettings,shareLinkView,publicWatermark,defaultWatermark} from "./share-link-settings.js";
import {shareScope} from "./share-scope.js";

async function owner(account:User,id:string,sql:Pick<typeof db,"query">=db) {
  await spaceRole(account,identifier(id),"manage",sql);
  const library=(await sql.query("SELECT id,name,created_by,kind FROM spaces WHERE id=$1",[id])).rows[0];
  if(library.kind!=="personal"||library.created_by!==account.id)fail(403,"只有创建者可分享个人知识库");
  return library;
}
async function publicLibrary(token:string) {
  if(!/^[\w-]{43}$/.test(token))fail(404,"知识库分享已失效");
  const library=(await db.query(`SELECT s.id,s.name,s.description,s.catalog_order,l.watermark_enabled,l.watermark_text,shared.name AS shared_by FROM library_share_links l JOIN spaces s ON s.id=l.space_id JOIN users u ON u.id=s.created_by JOIN users shared ON shared.id=l.created_by
    WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>now()) AND s.kind='personal' AND s.deleted_at IS NULL AND u.active`,[digest(token)])).rows[0];
  if(!library)fail(404,"知识库分享已失效");return library;
}
async function publicLibraryNote(token:string,id:string) {
  const library=await publicLibrary(token);
  const note=(await db.query("SELECT id,title,snapshot,updated_at FROM documents WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL AND NOT archived",[identifier(id),library.id])).rows[0];
  if(!note)fail(404,"笔记不存在或未共享");return note;
}
@Controller("api")
export class LibrarySharingController {
  constructor(@Inject(Documents) private readonly documents:Documents){}
  @Get("spaces/:id/sharing") async get(@Req() req:Request,@Param("id") id:string) {
    const account=await user(req),library=await owner(account,id);
    const members=(await db.query("SELECT u.id,u.name FROM personal_library_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=$1 AND u.active ORDER BY u.name,u.id",[id])).rows;
    const links=(await db.query("SELECT l.id,l.created_at,l.expires_at,l.revoked_at,l.token_encrypted,l.token_hash,l.watermark_enabled,l.watermark_text,u.name AS shared_by FROM library_share_links l JOIN users u ON u.id=l.created_by WHERE l.space_id=$1 ORDER BY l.created_at DESC",[id])).rows;
    return {library,members,links:links.map(link=>shareLinkView(link,"libraries")),watermark_default:defaultWatermark(account.name)};
  }
  @Post("spaces/:id/sharing/members") async add(@Req() req:Request,@Param("id") id:string,@Body() input:any) {
    const account=await user(req),identity=text(input?.identity,"完整用户名或邮箱",254).toLowerCase();
    await owner(account,id);
    const matches=(await db.query("SELECT id FROM users WHERE active AND (lower(username)=$1 OR (email_verified AND lower(email)=$1)) LIMIT 2",[identity])).rows;
    if(matches.length!==1)fail(404,"未找到唯一账号，请检查完整用户名或已验证邮箱");
    if(matches[0].id===account.id)fail(400,"你已拥有此知识库");
    await transaction(async sql=>{
      await sql.query("SELECT id FROM spaces WHERE id=$1 FOR UPDATE",[id]);await owner(account,id,sql);
      await sql.query("INSERT INTO personal_library_members(space_id,user_id,created_by) VALUES($1,$2,$3) ON CONFLICT(space_id,user_id) DO NOTHING",[id,matches[0].id,account.id]);
      await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'space.share.member',$2,$3)",[account.id,id,{user_id:matches[0].id,role:"viewer"}]);
    });
    return this.get(req,id);
  }
  @Delete("spaces/:id/sharing/members/:member") async remove(@Req() req:Request,@Param("id") id:string,@Param("member") member:string) {
    const account=await user(req);await owner(account,id);
    if(member===account.id)fail(400,"不能移除创建者");
    await transaction(async sql=>{
      await sql.query("SELECT id FROM spaces WHERE id=$1 FOR UPDATE",[id]);await owner(account,id,sql);
      await sql.query("DELETE FROM personal_library_members WHERE space_id=$1 AND user_id=$2",[id,identifier(member)]);
      await sql.query("UPDATE documents SET access_revision=access_revision+1 WHERE space_id=$1",[id]);
    });
    for(const note of (await db.query("SELECT id FROM documents WHERE space_id=$1 AND deleted_at IS NULL",[id])).rows)this.documents.disconnect(note.id);
    return {ok:true};
  }
  @Post("spaces/:id/sharing/links") async createLink(@Req() req:Request,@Param("id") id:string,@Body() input:any) {
    const account=await user(req),days=input?.days===undefined?7:input.days;
    if(days!==null&&![1,7,30].includes(days))fail(400,"请选择 1、7、30 天或永久有效");
    return transaction(async sql=>{
      await sql.query("SELECT id FROM spaces WHERE id=$1 FOR UPDATE",[identifier(id)]);await owner(account,id,sql);
      const token=randomBytes(32).toString("base64url"),linkId=randomUUID();
      const watermark=watermarkSettings(input,account.name);
      const link=(await sql.query("INSERT INTO library_share_links(id,space_id,token_hash,created_by,expires_at,token_encrypted,watermark_enabled,watermark_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,expires_at",[linkId,id,digest(token),account.id,days===null?null:new Date(Date.now()+days*86400000),sealShareToken(token),watermark.enabled,watermark.text])).rows[0];
      const path="/share/library/"+token;return {...link,path,url:platformConfig().public_origin?platformConfig().public_origin+path:null};
    });
  }
  @Delete("spaces/:id/sharing/links/:link") async revoke(@Req() req:Request,@Param("id") id:string,@Param("link") link:string) {
    await owner(await user(req),id);await db.query("UPDATE library_share_links SET revoked_at=now() WHERE space_id=$1 AND id=$2 AND revoked_at IS NULL",[id,identifier(link)]);return {ok:true};
  }
  @Patch("spaces/:id/sharing/links/:link") async updateLink(@Req() req:Request,@Param("id") id:string,@Param("link") link:string,@Body() input:any) {
    await owner(await user(req),id);const row=(await db.query("SELECT l.*,u.name AS shared_by FROM library_share_links l JOIN users u ON u.id=l.created_by WHERE l.id=$1 AND l.space_id=$2",[identifier(link),id])).rows[0];
    if(!row)fail(404,"分享记录不存在");const watermark=watermarkSettings(input,row.shared_by,row);await db.query("UPDATE library_share_links SET watermark_enabled=$2,watermark_text=$3 WHERE id=$1",[link,watermark.enabled,watermark.text]);return {ok:true};
  }
  @Delete("me/library-shares/:id/links") async revokeAll(@Req() req:Request,@Param("id") id:string) {
    const account=await user(req);await owner(account,id);const result=await db.query("UPDATE library_share_links SET revoked_at=now() WHERE space_id=$1 AND created_by=$2 AND revoked_at IS NULL",[id,account.id]);return {revoked:result.rowCount};
  }
  @Get("me/library-shares") async mine(@Req() req:Request) {
    const account=await user(req),q=req.query.q||"",status=req.query.status||"active",page=Number(req.query.page||1);
    if(typeof q!=="string"||q.length>200||typeof status!=="string"||!["active","all","inactive"].includes(status)||!Number.isSafeInteger(page)||page<1||page>100000)fail(400,"分享筛选无效");
    const selectedScope=await shareScope(account,req.query.scope);
    if(selectedScope&&selectedScope!=="personal")return {items:[],total:0,page,page_size:30};
    const rows=(await db.query(`WITH shared AS (SELECT s.id,s.name AS title,'个人知识库' AS space_name,NULL::text AS team_name,false AS archived,true AS external_allowed,
      (SELECT count(*)::int FROM personal_library_members m JOIN users u ON u.id=m.user_id AND u.active WHERE m.space_id=s.id) AS member_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'created_at',l.created_at,'expires_at',l.expires_at,'revoked_at',l.revoked_at,'token_encrypted',l.token_encrypted,'token_hash',l.token_hash,'watermark_enabled',l.watermark_enabled,'watermark_text',l.watermark_text) ORDER BY l.created_at DESC) FROM library_share_links l WHERE l.space_id=s.id),'[]'::jsonb) AS links,
      EXISTS(SELECT 1 FROM library_share_links l WHERE l.space_id=s.id AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>now())) AS live_link,s.created_at
      FROM spaces s WHERE s.kind='personal' AND s.created_by=$1 AND s.deleted_at IS NULL AND s.name ILIKE '%'||$2||'%'),scoped AS (SELECT *,member_count>0 OR live_link AS active FROM shared WHERE member_count>0 OR jsonb_array_length(links)>0)
      SELECT *,count(*) OVER()::int AS total FROM scoped WHERE $3='all' OR ($3='active' AND active) OR ($3='inactive' AND NOT active) ORDER BY created_at DESC,id LIMIT 30 OFFSET $4`,[account.id,q,status,(page-1)*30])).rows;
    return {items:rows.map(({total,live_link,created_at,...row})=>({...row,links:row.links.map((link:any)=>shareLinkView({...link,shared_by:account.name},"libraries"))})),total:rows[0]?.total||0,page,page_size:30};
  }
  @Get("public/libraries/:token") async list(@Param("token") token:string,@Res({passthrough:true}) res:Response) {
    const library=await publicLibrary(token);
    const notes=(await db.query("SELECT id,title,folder_id,updated_at FROM documents WHERE space_id=$1 AND deleted_at IS NULL AND NOT archived ORDER BY created_at,id",[library.id])).rows;
    const folders=(await db.query("SELECT id,name,parent_id FROM folders WHERE space_id=$1 ORDER BY position,name,id",[library.id])).rows;
    const all=[...folders.map(folder=>({key:"folder:"+folder.id,kind:"folder",id:folder.id,parent_id:folder.parent_id})),...notes.map(note=>({key:"note:"+note.id,kind:"note",id:note.id,parent_id:note.folder_id}))];
    const order=[...new Set([...library.catalog_order,...all.map(item=>item.key)])];
    res.setHeader("Cache-Control","no-store");res.setHeader("X-Robots-Tag","noindex, nofollow");return {id:library.id,name:library.name,description:library.description,watermark:publicWatermark(library),notes,folders,catalog:all.sort((a,b)=>order.indexOf(a.key)-order.indexOf(b.key))};
  }
  @Get("public/libraries/:token/notes/:id") async note(@Param("token") token:string,@Param("id") id:string) {
    const note=await publicLibraryNote(token,id),rows=await publicAssets(note),assets=new Set(rows.map(asset=>asset.id)),svgAssets=new Set<string>();
    // Public library URLs are read-only views; repair only their response, not
    // the source note. Inspect sequentially to bound open file descriptors.
    for(const asset of rows)if((await normalizeSvgAsset(asset)).mime==="image/svg+xml")svgAssets.add(asset.id);
    return {id:note.id,title:note.title,updated_at:note.updated_at,snapshot:publicSnapshot(note.snapshot,`/api/public/libraries/${token}/notes/${id}/assets`,assets,svgAssets)};
  }
  @Get("public/libraries/:token/notes/:id/assets/:asset") async file(@Req() req:Request,@Res() res:Response,@Param("token") token:string,@Param("id") id:string,@Param("asset") asset:string) {
    const note=await publicLibraryNote(token,id),stored=(await publicAssets(note)).find(item=>item.id===asset);
    if(!stored)fail(404,"附件不存在或未共享");
    const row=await normalizeSvgAsset(stored);
    await sendFile(req,res,storagePath("originals",row.storage_key),{mime:row.mime,filename:row.filename,hash:row.hash,inline:["image","video","audio","text"].includes(row.kind)&&req.query.download!=="1"});
  }
}

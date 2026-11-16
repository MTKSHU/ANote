import {Controller,Get,Post,Patch,Delete,Param,Query,Body,Req} from "@nestjs/common";
import type {Request} from "express";
import type {PoolClient} from "pg";
import {randomUUID} from "node:crypto";
import {db,transaction} from "./database.js";
import {user,documentRole} from "./auth.js";
import {fail,identifier,text} from "./errors.js";

async function notify(sql:PoolClient,input:{recipient:string;actor:string;kind:string;key:string;doc?:string;comment?:string;friendship?:string;invite?:string}) {
  if(input.recipient===input.actor)return;
  await sql.query(`INSERT INTO notifications(id,user_id,actor_id,kind,dedupe_key,doc_id,comment_id,friendship_id,invite_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
  [randomUUID(),input.recipient,input.actor,input.kind,input.key,input.doc||null,input.comment||null,input.friendship||null,input.invite||null]);
}

export async function notifyTeamInvite(sql:PoolClient,invite:string,recipient:string,actor:string) {
  await notify(sql,{recipient,actor,kind:"team_invite",key:"team-invite:"+invite,invite});
}

/** Candidates are scoped to this note's team, or the author's confirmed friends. */
async function eligible(sql:any,actor:string,doc:string,targets?:string[],query="") {
  return (await sql.query(`SELECT u.id,u.name,u.username,CASE WHEN u.email_verified THEN u.email ELSE NULL END AS email FROM documents d JOIN spaces s ON s.id=d.space_id
    JOIN users u ON u.active AND u.id<>$1
    WHERE d.id=$2 AND ($3::text[] IS NULL OR u.id=ANY($3))
    AND (s.kind='team' AND EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=s.team_id AND m.user_id=u.id)
      OR s.kind='personal' AND EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND f.user_low=LEAST($1,u.id) AND f.user_high=GREATEST($1,u.id)))
    AND ($4='' OR position(lower($4) in lower(u.name))>0 OR position(lower($4) in lower(u.username))>0 OR u.email_verified AND position(lower($4) in lower(u.email))>0)
    ORDER BY u.name,u.id LIMIT 30`,[actor,doc,targets||null,query])).rows;
}
function mentions(snapshot:any):Map<string,{userId:string;actorId:string}> {
  const result=new Map<string,{userId:string;actorId:string}>(),stack=[snapshot];let count=0;
  while(stack.length&&count++<25000){const node=stack.pop();if(!node||typeof node!=="object")continue;for(const mark of node.marks||[])if(mark.type==="mention"&&typeof mark.attrs?.userId==="string"&&typeof mark.attrs?.mentionId==="string"&&mark.attrs.mentionId.length<=80)result.set(mark.attrs.mentionId,{userId:mark.attrs.userId,actorId:mark.attrs.actorId});if(Array.isArray(node.content))for(const child of node.content)stack.push(child);}
  return result;
}
export async function notifyNoteMentions(sql:PoolClient,doc:string,before:any,after:any,actors:string[]) {
  const previous=mentions(before),added=[...mentions(after)].filter(([id])=>!previous.has(id));
  if(!added.length)return;
  // Only editors participating in this saved change can generate notifications.
  for(const actor of [...new Set(actors)]) {
    const role=(await sql.query("SELECT effective_document_role($1,$2) AS role",[actor,doc])).rows[0]?.role;
    if(!["admin","editor"].includes(role))continue;
    const own=added.filter(([,mention])=>mention.actorId===actor);
    if(!own.length)continue;
    const targets=await eligible(sql,actor,doc,own.map(([,mention])=>mention.userId));
    for(const [id,mention] of own)if(targets.some((target:any)=>target.id===mention.userId))await notify(sql,{recipient:mention.userId,actor,kind:"mention",key:`mention:${doc}:${id}`,doc});
  }
}
export async function notifyComment(sql:PoolClient,doc:string,comment:string,parent:string|null,actor:string) {
  const recipients=(await sql.query(`SELECT created_by AS id FROM documents WHERE id=$1
    UNION SELECT author FROM comments WHERE doc_id=$1 AND ($2::text IS NOT NULL AND (id=$2 OR parent_id=$2))`,[doc,parent||comment])).rows;
  for(const target of recipients){const access=(await sql.query("SELECT effective_document_role($1,$2) AS role",[target.id,doc])).rows[0]?.role;if(access)await notify(sql,{recipient:target.id,actor,kind:"comment",key:"comment:"+comment,doc,comment});}
}

@Controller("api")
export class SocialController {
  @Get("friends") async friends(@Req() req:Request) {
    const account=await user(req);
    return (await db.query(`SELECT f.id,f.status,f.requested_by,f.created_at,u.id AS user_id,u.name,u.username
      FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END
      WHERE $1 IN(f.user_low,f.user_high) AND u.active ORDER BY f.created_at DESC`,[account.id])).rows;
  }
  @Post("friend-requests") async request(@Req() req:Request,@Body() input:any) {
    const account=await user(req),target=text(input?.account,"用户名或邮箱",254).toLowerCase();
    await transaction(async sql=>{
      await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))",["friends:"+account.id]);
      if(Number((await sql.query("SELECT count(*) FROM friendships WHERE requested_by=$1 AND status='pending'",[account.id])).rows[0].count)>=30)fail(429,"待处理的好友申请过多，请先取消部分申请");
      const peer=(await sql.query("SELECT id FROM users WHERE active AND id<>$1 AND (lower(username)=$2 OR email_verified AND lower(email)=$2) LIMIT 1",[account.id,target])).rows[0];
      if(!peer)return;
      const pair=[account.id,peer.id].sort();
      const row=(await sql.query("INSERT INTO friendships(id,user_low,user_high,requested_by) VALUES($1,$2,$3,$4) ON CONFLICT(user_low,user_high) DO NOTHING RETURNING id",[randomUUID(),...pair,account.id])).rows[0];
      if(row)await notify(sql,{recipient:peer.id,actor:account.id,kind:"friend_request",key:"friend:"+row.id,friendship:row.id});
    });
    return {ok:true};
  }
  @Patch("friend-requests/:id") async respond(@Req() req:Request,@Param("id") id:string,@Body() input:any) {
    const account=await user(req);if(!["accept","reject","cancel"].includes(input?.action))fail(400,"申请操作无效");
    return transaction(async sql=>{
      const row=(await sql.query("SELECT * FROM friendships WHERE id=$1 AND $2 IN(user_low,user_high) FOR UPDATE",[identifier(id),account.id])).rows[0];
      if(!row||row.status!=="pending")fail(404,"申请不存在或已处理");
      if(input.action==="cancel"?row.requested_by!==account.id:row.requested_by===account.id)fail(403,"不能处理此申请");
      if(input.action==="accept") {await sql.query("UPDATE friendships SET status='accepted' WHERE id=$1",[id]);await notify(sql,{recipient:row.requested_by,actor:account.id,kind:"friend_accepted",key:"accepted:"+id,friendship:id});}
      else await sql.query("DELETE FROM friendships WHERE id=$1",[id]);
      await sql.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND friendship_id=$2 AND read_at IS NULL",[account.id,id]);
      return {ok:true};
    });
  }
  @Delete("friends/:id") async remove(@Req() req:Request,@Param("id") id:string) {
    const account=await user(req);const result=await db.query("DELETE FROM friendships WHERE id=$1 AND $2 IN(user_low,user_high) AND status='accepted'",[identifier(id),account.id]);if(!result.rowCount)fail(404,"好友关系不存在");return {ok:true};
  }
  @Get("social/badges") async badges(@Req() req:Request) {
    const account=await user(req);return (await db.query(`SELECT
      (SELECT count(*)::int FROM notifications WHERE user_id=$1 AND read_at IS NULL) AS unread,
      (SELECT count(*)::int FROM friendships WHERE $1 IN(user_low,user_high) AND requested_by<>$1 AND status='pending') AS requests`,[account.id])).rows[0];
  }
  @Get("notifications") async notifications(@Req() req:Request,@Query("offset") rawOffset?:string,@Query("unread") unread?:string) {
    const account=await user(req),offset=Math.trunc(Math.max(0,Math.min(100000,Number(rawOffset)||0)));
    const rows=(await db.query(`SELECT n.id,n.kind,n.created_at,n.read_at,n.friendship_id,a.name AS actor_name,
      CASE WHEN n.kind='team_invite' THEN t.name END AS team_name,
      CASE WHEN n.kind='team_invite' THEN i.expires_at END AS invite_expires_at,
      CASE WHEN n.kind='team_invite' THEN CASE
        WHEN i.id IS NULL OR i.target_user_id IS DISTINCT FROM $1 OR t.id IS NULL OR t.deleted_at IS NOT NULL OR t.archived THEN 'unavailable'
        WHEN i.accepted_by=$1 AND EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=i.team_id AND m.user_id=$1) THEN 'accepted'
        WHEN i.accepted_by IS NOT NULL THEN 'unavailable'
        WHEN i.declined_at IS NOT NULL THEN 'rejected'
        WHEN i.revoked_at IS NOT NULL THEN 'revoked'
        WHEN i.expires_at<=now() THEN 'expired'
        ELSE 'pending' END END AS invite_status,
      CASE WHEN effective_document_role($1,n.doc_id) IS NOT NULL THEN n.doc_id END AS doc_id,
      CASE WHEN effective_document_role($1,n.doc_id) IS NOT NULL THEN d.title END AS note_title,
      CASE WHEN effective_document_role($1,n.doc_id) IS NOT NULL THEN left(c.body,180) END AS comment_text,
      (n.doc_id IS NULL OR effective_document_role($1,n.doc_id) IS NOT NULL) AS available
      FROM notifications n JOIN users a ON a.id=n.actor_id LEFT JOIN documents d ON d.id=n.doc_id LEFT JOIN comments c ON c.id=n.comment_id LEFT JOIN team_invites i ON i.id=n.invite_id LEFT JOIN teams t ON t.id=i.team_id
      WHERE n.user_id=$1 AND ($3<>'true' OR n.read_at IS NULL) ORDER BY n.created_at DESC,n.id DESC LIMIT 51 OFFSET $2`,[account.id,offset,unread||""])).rows;
    return {items:rows.slice(0,50),next_offset:rows.length>50?offset+50:null};
  }
  @Post("notifications/read") async read(@Req() req:Request,@Body() input:any) {
    const account=await user(req);if(input?.id)await db.query("UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND id=$2",[account.id,identifier(input.id)]);
    else await db.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",[account.id]);return {ok:true};
  }
  @Get("documents/:id/mention-candidates") async candidates(@Req() req:Request,@Param("id") id:string,@Query("q") q?:string) {
    const account=await user(req);await documentRole(account,identifier(id),"edit");return eligible(db,account.id,id,undefined,(q||"").slice(0,254));
  }
}

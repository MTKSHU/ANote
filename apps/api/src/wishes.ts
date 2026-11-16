import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { administrator, user, type User } from "./auth.js";
import { transaction } from "./database.js";
import { fail, identifier, optionalText, text } from "./errors.js";

const statuses = ["submitted", "planned", "in_progress", "completed", "declined"];
const moderationStatuses = ["pending","published","rejected"];
// Never serialize database rows directly: anonymous authors must not leak via IDs,
// usernames, emails, or joins. Only a platform admin gets the traceable nickname.
function present(row: any, account: User) {
  return {
    id: row.id, title: row.title, content: row.content, category: row.category,
    anonymous: row.anonymous, author: row.anonymous ? "匿名用户" : row.author_name,
    ...(account.is_admin && row.anonymous ? { submitter_name: row.author_name } : {}),
    mine: row.created_by === account.id, status: row.status, reply: row.reply,
    moderation_status: row.moderation_status,
    revision: row.revision, created_at: row.created_at, updated_at: row.updated_at,
  };
}
const selection = "SELECT w.*,u.name AS author_name FROM wishes w JOIN users u ON u.id=w.created_by";
@Controller("api/wishes")
export class WishesController {
  @Get() async list(@Req() req: Request, @Query() query: any) {
    const account = await user(req);
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400, "页码无效");
    if (query.status && !statuses.includes(query.status)) fail(400, "状态无效");
    if (query.moderation && !moderationStatuses.includes(query.moderation)) fail(400,"展示状态无效");
    if (query.mine !== undefined && !["true", "false"].includes(query.mine)) fail(400, "筛选无效");
    const args = [query.mine === "true" ? account.id : null, query.status || null,account.id,account.is_admin,query.moderation || null];
    const where = " WHERE ($1::text IS NULL OR w.created_by=$1) AND ($2::text IS NULL OR w.status=$2) AND (w.moderation_status='published' OR w.created_by=$3 OR $4::boolean) AND ($5::text IS NULL OR w.moderation_status=$5)";
    // One MVCC snapshot keeps pagination consistent while other users submit.
    return transaction(async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const total = Number((await client.query("SELECT count(*) FROM wishes w" + where, args)).rows[0].count);
      const rows = (await client.query(selection + where + " ORDER BY w.created_at DESC,w.id DESC LIMIT 30 OFFSET $6", [...args, (page - 1) * 30])).rows;
      const policy=(await client.query("SELECT wish_review_mode FROM platform_settings WHERE singleton")).rows[0];
      return { items: rows.map(row => present(row, account)), total, page, page_size: 30, review_mode: policy.wish_review_mode };
    });
  }
  @Post() async create(@Req() req: Request, @Body() input: any) {
    const account = await user(req);
    const title = text(input?.title, "标题", 120), content = text(input?.content, "建议内容", 5000);
    if (!["feature", "improvement"].includes(input?.category)) fail(400, "请选择建议类型");
    if (typeof input?.anonymous !== "boolean") fail(400, "请选择是否匿名");
    if (/[\u0000-\u001f\u007f]/u.test(title) || content.includes("\u0000")) fail(400, "内容包含无效字符");
    return transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["wish-create:" + account.id]);
      const count = Number((await client.query("SELECT count(*) FROM wishes WHERE created_by=$1 AND created_at>now()-interval '24 hours'", [account.id])).rows[0].count);
      if (count >= 20) fail(429, "今天已提交 20 条建议，请明天再来");
      const policy=(await client.query("SELECT wish_review_mode FROM platform_settings WHERE singleton FOR SHARE")).rows[0];
      const row = (await client.query("INSERT INTO wishes(id,created_by,title,content,category,anonymous,moderation_status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [randomUUID(), account.id, title, content, input.category, input.anonymous,policy.wish_review_mode === "approval" ? "pending" : "published"])).rows[0];
      return present({ ...row, author_name: account.name }, account);
    });
  }
  @Patch(":id") async update(@Req() req: Request, @Param("id") id: string, @Body() input: any) {
    const account = await user(req); administrator(account);
    identifier(id);
    if (!statuses.includes(input?.status)) fail(400, "状态无效");
    if (input.moderation_status !== undefined && !moderationStatuses.includes(input.moderation_status)) fail(400,"展示状态无效");
    if (!Number.isSafeInteger(input?.revision) || input.revision < 1) fail(400, "版本无效");
    const reply = optionalText(input?.reply, 3000).trim();
    if (reply.includes("\u0000")) fail(400, "回复包含无效字符");
    return transaction(async client => {
      const row = (await client.query("SELECT * FROM wishes WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) fail(404, "建议不存在");
      if (row.revision !== input.revision) fail(409, "建议已被更新，请刷新后重试");
      await client.query("UPDATE wishes SET status=$2,reply=$3,moderation_status=$4,reviewed_by=CASE WHEN moderation_status<>$4 THEN $5 ELSE reviewed_by END,reviewed_at=CASE WHEN moderation_status<>$4 THEN now() ELSE reviewed_at END,revision=revision+1,updated_at=now() WHERE id=$1", [id, input.status, reply,input.moderation_status ?? row.moderation_status,account.id]);
      await client.query("INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'wish.update',$2,$3)",[account.id,id,{moderation_status:input.moderation_status ?? row.moderation_status,status:input.status}]);
      return present((await client.query(selection + " WHERE w.id=$1", [id])).rows[0], account);
    });
  }
  @Delete(":id") async remove(@Req() req: Request, @Param("id") id: string) {
    const account = await user(req); identifier(id);
    return transaction(async sql=>{
      const result = await sql.query("DELETE FROM wishes WHERE id=$1 AND (created_by=$2 OR $3::boolean) RETURNING id", [id, account.id, account.is_admin]);
      if (!result.rowCount) fail(404, "建议不存在或无权删除");
      await sql.query("INSERT INTO audit_events(actor,action,target) VALUES($1,'wish.delete',$2)",[account.id,id]);
      return { ok: true };
    });
  }
}

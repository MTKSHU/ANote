import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Req,
  Body,
  Inject,
} from "@nestjs/common";
import type { Request } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { db, digest, transaction } from "./database.js";
import { user, type User } from "./auth.js";
import { fail, text, optionalText, identifier } from "./errors.js";
import { Documents } from "./documents.js";
export async function teamRole(
  account: User,
  id: string,
  manage = false,
  archived = false,
) {
  const row = (
    await db.query(
      "SELECT t.*,m.role FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$2 WHERE t.id=$1",
      [identifier(id), account.id],
    )
  ).rows[0];
  if (!row) fail(403, "没有此团队的访问权限");
  if (row.deleted_at) fail(404, "团队已移入回收站");
  if (row.archived && !archived) fail(403, "团队已归档");
  if (manage && row.role !== "admin") fail(403, "仅团队管理员可执行此操作");
  return row;
}
export async function listTeams(account: User) {
  const teams = (
    await db.query(
      `SELECT t.*,m.role,(SELECT count(*)::int FROM team_members p WHERE p.team_id=t.id) AS member_count,
 (SELECT count(*)::int FROM spaces s WHERE s.team_id=t.id AND effective_space_role($1,s.id) IS NOT NULL) AS library_count
 FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 WHERE t.deleted_at IS NULL ORDER BY t.created_at`,
      [account.id],
    )
  ).rows;
  return Promise.all(teams.map(async team => ({...team,pinned_note_ids: await visiblePins(account,team)})));
}
async function visiblePins(account: User, team: any) {
  if (team.archived || !team.pinned_note_ids?.length) return [];
  const rows = (await db.query("SELECT d.id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE s.team_id=$1 AND d.id=ANY($2::text[]) AND NOT d.archived AND effective_document_role($3,d.id) IS NOT NULL",[team.id,team.pinned_note_ids,account.id])).rows;
  return team.pinned_note_ids.filter((id: string) => rows.some(r => r.id === id));
}
export async function createTeam(account: User, input: any) {
  const id = randomUUID(),
    name = text(input?.name, "团队名称", 80),
    description = optionalText(input?.description, 1000);
  return transaction(async (client) => {
    const row = (
      await client.query(
        "INSERT INTO teams(id,name,description,created_by) VALUES($1,$2,$3,$4) RETURNING *",
        [id, name, description, account.id],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')",
      [id, account.id],
    );
    await client.query(
      "INSERT INTO audit_events(actor,action,target) VALUES($1,'team.create',$2)",
      [account.id, id],
    );
    return { ...row, role: "admin" };
  });
}
export async function externalSharingAllowed(noteId: string) {
  const row = (
    await db.query(
      "SELECT s.kind,t.allow_external_sharing,t.archived FROM documents d JOIN spaces s ON s.id=d.space_id LEFT JOIN teams t ON t.id=s.team_id WHERE d.id=$1 AND d.deleted_at IS NULL AND s.deleted_at IS NULL AND t.deleted_at IS NULL",
      [noteId],
    )
  ).rows[0];
  return (
    !!row &&
    (row.kind === "personal" || (!row.archived && row.allow_external_sharing))
  );
}
@Controller("api")
export class TeamsController {
  constructor(@Inject(Documents) private readonly documents: Documents) {}
  @Get("teams") async list(@Req() req: Request) {
    return listTeams(await user(req));
  }
  @Post("teams") async create(@Req() req: Request, @Body() input: any) {
    return createTeam(await user(req), input);
  }
  @Get("teams/:id") async get(@Req() req: Request, @Param("id") id: string) {
    const account = await user(req),
      team = await teamRole(account, id, false, true);
    const libraries = team.archived
      ? []
      : (
          await db.query(
            "SELECT s.*,u.name AS creator_name,effective_space_role($2,s.id) AS role FROM spaces s JOIN users u ON u.id=s.created_by WHERE s.team_id=$1 AND effective_space_role($2,s.id) IS NOT NULL ORDER BY s.pinned DESC,s.created_at",
            [id, account.id],
          )
        ).rows;
    return {
      ...team,
      pinned_note_ids: await visiblePins(account,team),
      libraries: libraries.map(({catalog_order,...library}) => library),
      members: (
        await db.query(
          "SELECT u.id,u.name,u.username,u.email,u.email_verified,m.role FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND u.active ORDER BY m.role,u.name",
          [id],
        )
      ).rows,
      invites:
        team.role === "admin"
          ? (
              await db.query(
                "SELECT i.id,i.email,i.expires_at,i.revoked_at,i.accepted_by,i.reusable,(SELECT count(*)::int FROM team_invite_acceptances a WHERE a.invite_id=i.id) AS acceptance_count FROM team_invites i WHERE i.team_id=$1 ORDER BY i.created_at DESC LIMIT 100",
                [id],
              )
            ).rows
          : [],
    };
  }
  @Patch("teams/:id") async update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const account = await user(req);
    const team = await teamRole(account, id, true, true);
    const pins = input.pinned_note_ids === undefined ? team.pinned_note_ids : input.pinned_note_ids;
    if (!Array.isArray(pins) || pins.length > 20 || pins.some(p => typeof p !== "string")) fail(400,"最多置顶 20 篇笔记");
    if (input.pinned_note_ids !== undefined && pins.length && Number((await db.query("SELECT count(*) FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.id=ANY($1::text[]) AND s.team_id=$2 AND NOT d.archived AND effective_document_role($3,d.id) IS NOT NULL",[pins,id,account.id])).rows[0].count) !== new Set(pins).size) fail(400,"置顶笔记必须属于本团队且可访问");
    for (const k of [
      "allow_external_sharing",
      "members_can_create_libraries",
      "archived",
    ])
      if (input[k] !== undefined && typeof input[k] !== "boolean")
        fail(400, "团队设置无效");
    const announcement =
      input.announcement_doc_id === undefined
        ? team.announcement_doc_id
        : input.announcement_doc_id;
    if (
      announcement &&
      announcement !== team.announcement_doc_id &&
      !(
        await db.query(
          "SELECT 1 FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.id=$1 AND s.team_id=$2 AND s.access_mode='team' AND d.visibility='team' AND NOT d.archived AND d.deleted_at IS NULL AND s.deleted_at IS NULL",
          [identifier(announcement), id],
        )
      ).rowCount
    )
      fail(400, "公告必须选择本团队公开知识库中未归档的团队可见笔记");
    await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "team:" + id,
      ]);
      if (
        !(
          await client.query(
            "SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND role='admin'",
            [id, account.id],
          )
        ).rowCount
      )
        fail(403, "团队管理员权限已变更");
      await client.query(
        "UPDATE teams SET name=$2,description=$3,allow_external_sharing=$4,members_can_create_libraries=$5,announcement_doc_id=$6,archived=$7,pinned_note_ids=$8 WHERE id=$1",
        [
          id,
          input.name === undefined
            ? team.name
            : text(input.name, "团队名称", 80),
          input.description === undefined
            ? team.description
            : optionalText(input.description, 1000),
          input.allow_external_sharing ?? team.allow_external_sharing,
          input.members_can_create_libraries ??
            team.members_can_create_libraries,
          announcement || null,
          input.archived ?? team.archived,
          [...new Set(pins)],
        ],
      );
      if (input.allow_external_sharing === false)
        await client.query(
          "UPDATE document_share_links SET revoked_at=now() WHERE doc_id IN(SELECT d.id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE s.team_id=$1) AND revoked_at IS NULL",
          [id],
        );
      await client.query(
        "INSERT INTO audit_events(actor,action,target) VALUES($1,'team.settings',$2)",
        [account.id, id],
      );
    });
    if (input.archived !== undefined)
      for (const row of (
        await db.query(
          "SELECT d.id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE s.team_id=$1",
          [id],
        )
      ).rows)
        this.documents.disconnect(row.id);
    return this.get(req, id);
  }
  @Post("teams/:id/members") async member(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const account = await user(req),
      target = identifier(input?.user_id),
      role = input.role;
    if (!["admin", "member", null].includes(role)) fail(400, "团队角色无效");
    const team = await teamRole(account, id, false, true);
    if (!(target === account.id && role === null) && team.role !== "admin")
      fail(403, "仅团队管理员可管理成员");
    await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "team:" + id,
      ]);
      const actor = (
        await client.query(
          "SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2",
          [id, account.id],
        )
      ).rows[0];
      if (
        !actor ||
        (!(target === account.id && role === null) && actor.role !== "admin")
      )
        fail(403, "团队管理权限已变更");
      const old = (
        await client.query(
          "SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2",
          [id, target],
        )
      ).rows[0];
      if (
        old?.role === "admin" &&
        role !== "admin" &&
        Number(
          (
            await client.query(
              "SELECT count(*) FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.role='admin' AND u.active",
              [id],
            )
          ).rows[0].count,
        ) <= 1
      )
        fail(409, "团队至少保留一名启用的管理员");
      if (role === null) {
        await client.query(
          "DELETE FROM team_members WHERE team_id=$1 AND user_id=$2",
          [id, target],
        );
        await client.query(
          "DELETE FROM space_members WHERE user_id=$2 AND space_id IN(SELECT id FROM spaces WHERE team_id=$1)",
          [id, target],
        );
        await client.query(
          "DELETE FROM document_collaborators WHERE user_id=$2 AND doc_id IN(SELECT d.id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE s.team_id=$1)",
          [id, target],
        );
      } else {
        if (
          !(
            await client.query("SELECT 1 FROM users WHERE id=$1 AND active", [
              target,
            ])
          ).rowCount
        )
          fail(400, "请先邀请启用的用户加入");
        if (!old) fail(400, "用户需通过邀请加入团队后再调整角色");
        await client.query(
          "UPDATE team_members SET role=$3 WHERE team_id=$1 AND user_id=$2",
          [id, target, role],
        );
      }
      await client.query(
        "UPDATE documents SET access_revision=access_revision+1 WHERE space_id IN(SELECT id FROM spaces WHERE team_id=$1)",
        [id],
      );
      await client.query(
        "INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'team.member',$2,$3)",
        [account.id, id, { user_id: target, role }],
      );
    });
    this.documents.disconnectUser(target);
    return { ok: true };
  }
  @Post("teams/:id/invites") async invite(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const account = await user(req);
    const email = input?.email
      ? text(input.email, "邀请邮箱", 254).toLowerCase()
      : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fail(400, "邮箱无效");
    return transaction(async (client) => {
      await client.query("SELECT id FROM teams WHERE id=$1 FOR UPDATE", [
        identifier(id),
      ]);
      await teamRole(account, id, true);
      const token = randomBytes(32).toString("base64url"),
        invitation = (
          await client.query(
            "INSERT INTO team_invites(id,team_id,token_hash,email,created_by,expires_at,reusable) VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6) RETURNING id,email,expires_at,reusable",
            [randomUUID(), id, digest(token), email, account.id, !email],
          )
        ).rows[0];
      await client.query(
        "INSERT INTO audit_events(actor,action,target) VALUES($1,'team.invite',$2)",
        [account.id, id],
      );
      return { ...invitation, path: "/?invite=" + token };
    });
  }
  @Delete("teams/:id/invites/:invite") async revoke(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("invite") invite: string,
  ) {
    await teamRole(await user(req), id, true);
    await db.query(
      "UPDATE team_invites SET revoked_at=now() WHERE id=$1 AND team_id=$2",
      [identifier(invite), id],
    );
    return { ok: true };
  }
  @Get("team-invitations/:token") async preview(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    await user(req);
    const row = (
      await db.query(
        "SELECT t.name,i.email,i.expires_at,i.reusable FROM team_invites i JOIN teams t ON t.id=i.team_id WHERE i.token_hash=$1 AND i.expires_at>now() AND i.revoked_at IS NULL AND (i.reusable OR i.accepted_by IS NULL) AND NOT t.archived AND t.deleted_at IS NULL",
        [digest(token)],
      )
    ).rows[0];
    if (!row) fail(404, "邀请已失效");
    return row;
  }
  @Post("team-invitations/:token/accept") async accept(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    const account = await user(req);
    return transaction(async (client) => {
      // Match team deletion's lock order. Keep the team's state stable until
      // joining completes, then serialize acceptance/revocation on the link.
      const team = (
        await client.query(
          "SELECT t.id,t.archived,t.deleted_at FROM teams t JOIN team_invites i ON i.team_id=t.id WHERE i.token_hash=$1 FOR SHARE OF t",
          [digest(token)],
        )
      ).rows[0];
      if (!team || team.archived || team.deleted_at) fail(404, "邀请已失效");
      const row = (
        await client.query(
          "SELECT * FROM team_invites WHERE token_hash=$1 FOR UPDATE",
          [digest(token)],
        )
      ).rows[0];
      if (
        !row ||
        row.revoked_at ||
        (!row.reusable && row.accepted_by) ||
        new Date(row.expires_at).getTime() <= Date.now()
      )
        fail(404, "邀请已失效");
      const person = (
        await client.query(
          "SELECT email,email_verified FROM users WHERE id=$1 AND active",
          [account.id],
        )
      ).rows[0];
      if (!person) fail(403, "账号已停用");
      if (
        row.email &&
        (!person?.email_verified || person.email?.toLowerCase() !== row.email)
      )
        fail(403, "此邀请需要使用对应的已验证邮箱账号接受");
      const added = await client.query(
        "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING RETURNING user_id",
        [row.team_id, account.id],
      );
      if (added.rowCount) {
        await client.query(
          "INSERT INTO team_invite_acceptances(invite_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [row.id, account.id],
        );
        if (!row.reusable) await client.query("UPDATE team_invites SET accepted_by=$2 WHERE id=$1", [row.id, account.id]);
        await client.query(
          "INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'team.join',$2,$3)",
          [account.id, row.team_id, {invite_id: row.id}],
        );
      }
      return { team_id: row.team_id };
    });
  }
}

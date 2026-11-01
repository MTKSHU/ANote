import { randomUUID } from "node:crypto";
import { db, transaction } from "./database.js";
import { administrator, passwordHash, type User } from "./auth.js";
import { fail, text, optionalText } from "./errors.js";

export async function team(account: User) {
  administrator(account);
  return {
    ...(await db.query("SELECT name,description FROM team_profile")).rows[0],
    members: (
      await db.query(`SELECT u.id,u.username,u.name,u.active,u.is_admin,u.membership_status,u.local_password_enabled,u.created_at,u.email,u.email_verified,
      EXISTS(SELECT 1 FROM auth_identities i WHERE i.user_id=u.id) AS casdoor_linked,
      COALESCE((SELECT json_agg(json_build_object('space_id',m.space_id,'name',s.name,'role',m.role) ORDER BY s.name)
        FROM space_members m JOIN spaces s ON s.id=m.space_id WHERE m.user_id=u.id AND s.kind='team'),'[]') AS libraries
      FROM users u ORDER BY (u.membership_status='pending') DESC,u.created_at DESC`)
    ).rows,
    libraries: (
      await db.query(
        "SELECT id,name FROM spaces WHERE kind='team' ORDER BY name",
      )
    ).rows,
  };
}
export async function updateTeam(account: User, input: any) {
  administrator(account);
  await db.query("UPDATE team_profile SET name=$1,description=$2", [
    text(input?.name, "团队名称", 80),
    optionalText(input?.description, 1000),
  ]);
  return { ok: true };
}
export async function updateMember(account: User, id: string, input: any) {
  administrator(account);
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "成员设置无效");
  if (
    input.password !== undefined &&
    (typeof input.password !== "string" ||
      input.password.length < 12 ||
      input.password.length > 512)
  )
    fail(400, "密码需为 12–512 位字符");
  const hash =
    input.password === undefined ? null : await passwordHash(input.password);
  if (
    input?.status !== undefined &&
    !["active", "pending", "disabled"].includes(input.status)
  )
    fail(400, "成员状态无效");
  if (input?.is_admin !== undefined && typeof input.is_admin !== "boolean")
    fail(400, "管理员设置无效");
  const changedDocs = await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('anote:team-admins'))",
    );
    const actor = (
      await client.query(
        "SELECT * FROM users WHERE id=$1 AND active AND is_admin",
        [account.id],
      )
    ).rows[0];
    if (!actor) fail(403, "管理员权限已失效");
    const target = (
      await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!target) fail(404, "成员不存在");
    if (input.email !== undefined) {
      const email = input.email
        ? text(input.email, "邮箱", 254).toLowerCase()
        : null;
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) fail(400, "邮箱无效");
      if (
        email &&
        (
          await client.query(
            "SELECT 1 FROM users WHERE lower(email)=$1 AND email_verified AND id<>$2",
            [email, id],
          )
        ).rowCount
      )
        fail(409, "该邮箱已关联其他用户");
      await client.query(
        "UPDATE users SET email=$2,email_verified=$3 WHERE id=$1",
        [id, email, !!email && input.email_verified === true],
      );
    }
    const affected = (
      await client.query(
        `SELECT d.id FROM documents d WHERE d.created_by=$1
      OR EXISTS(SELECT 1 FROM document_collaborators c WHERE c.doc_id=d.id AND c.user_id=$1)
      OR (d.visibility='team' AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=d.space_id AND s.kind='team')
        AND ($2 OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=d.space_id AND m.user_id=$1)))`,
        [id, target.is_admin],
      )
    ).rows.map((row) => row.id);
    const status = input.status ?? target.membership_status,
      admin = input.is_admin ?? target.is_admin;
    if (id === account.id && (status !== "active" || !admin))
      fail(409, "不能停用自己或移除自己的管理员权限");
    if (
      target.is_admin &&
      target.active &&
      (status !== "active" || !admin) &&
      Number(
        (
          await client.query(
            "SELECT count(*) FROM users WHERE active AND is_admin",
          )
        ).rows[0].count,
      ) <= 1
    )
      fail(409, "至少保留一名启用的团队管理员");
    if (hash && !target.local_password_enabled)
      fail(400, "Casdoor 账号的密码请在 Casdoor 中修改");
    if (input.libraries !== undefined) {
      if (!Array.isArray(input.libraries) || input.libraries.length > 200)
        fail(400, "知识库权限无效");
      const seen = new Set<string>();
      for (const entry of input.libraries) {
        if (
          !entry ||
          typeof entry.space_id !== "string" ||
          seen.has(entry.space_id) ||
          !["admin", "editor", "reviewer", "viewer"].includes(entry.role)
        )
          fail(400, "知识库权限无效");
        seen.add(entry.space_id);
        if (
          !(
            await client.query(
              "SELECT 1 FROM team_members m JOIN spaces s ON s.team_id=m.team_id WHERE s.id=$1 AND m.user_id=$2",
              [entry.space_id, id],
            )
          ).rowCount
        )
          fail(400, "请先邀请该用户加入对应团队");
        if (
          !(
            await client.query(
              "SELECT 1 FROM spaces WHERE id=$1 AND kind='team'",
              [entry.space_id],
            )
          ).rowCount
        )
          fail(400, "只能分配团队知识库");
      }
      const removed = (
        await client.query(
          "DELETE FROM space_members m USING spaces s WHERE s.id=m.space_id AND s.kind='team' AND m.user_id=$1 AND NOT(m.space_id=ANY($2::text[])) RETURNING m.space_id",
          [id, [...seen]],
        )
      ).rows;
      // Match explicit knowledge-base removal: revoke direct document invitations in that library too.
      for (const row of removed)
        await client.query(
          "DELETE FROM document_collaborators c USING documents d WHERE c.doc_id=d.id AND d.space_id=$1 AND c.user_id=$2",
          [row.space_id, id],
        );
      for (const entry of input.libraries)
        await client.query(
          "INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role",
          [entry.space_id, id, entry.role],
        );
    }
    await client.query(
      "UPDATE users SET name=$2,is_admin=$3,active=$4,membership_status=$5,password_hash=COALESCE($6,password_hash) WHERE id=$1",
      [
        id,
        input.name === undefined ? target.name : text(input.name, "姓名", 80),
        admin,
        status === "active",
        status,
        hash,
      ],
    );
    const permissionsChanged =
      input.libraries !== undefined ||
      admin !== target.is_admin ||
      status !== target.membership_status ||
      !!hash;
    if (permissionsChanged)
      await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await client.query(
      "INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'team.member.update',$2,$3)",
      [
        account.id,
        id,
        JSON.stringify({
          status,
          is_admin: admin,
          password_reset: !!hash,
          libraries_changed: input.libraries !== undefined,
        }),
      ],
    );
    if (permissionsChanged) {
      // Invalidate resources this member could previously access; other live collaborators stay connected.
      await client.query(
        "UPDATE documents SET access_revision=access_revision+1 WHERE id=ANY($1::text[])",
        [affected],
      );
      return true;
    }
    return false;
  });
  return changedDocs;
}

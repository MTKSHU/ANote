import { randomUUID } from "node:crypto";
import { db, transaction } from "./database.js";
import {
  type User,
  spaceRole,
  administrator,
  readableDocumentSQL,
} from "./auth.js";
import { teamRole } from "./teams.js";
import { fail, text, optionalText, identifier } from "./errors.js";

export async function spaces(account: User) {
  return (
    await db.query(
      `SELECT s.*,u.name AS creator_name,effective_space_role($1,s.id) AS role,
       p.created_at IS NOT NULL AS sidebar_pinned,p.created_at AS sidebar_pinned_at,
       (SELECT count(*)::int FROM documents d WHERE d.space_id=s.id AND NOT d.archived AND effective_document_role($1,d.id) IS NOT NULL) AS note_count,
       (SELECT count(*)::int FROM folders f WHERE f.space_id=s.id) AS folder_count
       FROM spaces s JOIN users u ON u.id=s.created_by LEFT JOIN user_library_pins p ON p.user_id=$1 AND p.space_id=s.id
       WHERE effective_space_role($1,s.id) IS NOT NULL ORDER BY s.pinned DESC,s.created_at`,
      [account.id],
    )
  ).rows.map(({catalog_order, ...row}) => row);
}
export async function setSidebarPin(account: User, id: string, input: any) {
  if (typeof input?.pinned !== "boolean") fail(400, "固定设置无效");
  return transaction(async (client) => {
    const space = (
      await client.query(
        "SELECT id,effective_space_role($2,id) AS role FROM spaces WHERE id=$1 FOR KEY SHARE",
        [id, account.id],
      )
    ).rows[0];
    if (!space) fail(404, "知识库不存在");
    if (!space.role) fail(403, "无此知识库权限");
    if (input.pinned)
      await client.query(
        "INSERT INTO user_library_pins(user_id,space_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [account.id, id],
      );
    else
      await client.query(
        "DELETE FROM user_library_pins WHERE user_id=$1 AND space_id=$2",
        [account.id, id],
      );
    const pin = input.pinned ? (await client.query("SELECT created_at FROM user_library_pins WHERE user_id=$1 AND space_id=$2",[account.id,id])).rows[0] : null;
    return { sidebar_pinned: input.pinned, sidebar_pinned_at: pin?.created_at || null };
  });
}
export async function createSpace(account: User, input: any) {
  const kind = input?.kind || "team";
  if (!["personal", "team"].includes(kind)) fail(400, "知识库类型无效");
  let teamId: string | null = null;
  if (kind === "team") {
    teamId = input?.team_id
      ? identifier(input.team_id)
      : (
          await db.query(
            "SELECT t.id FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 AND NOT t.archived AND t.deleted_at IS NULL ORDER BY t.created_at LIMIT 1",
            [account.id],
          )
        ).rows[0]?.id;
    if (!teamId) fail(400, "请先创建或选择一个团队");
    const team = await teamRole(account, teamId);
    if (team.role !== "admin" && !team.members_can_create_libraries)
      fail(403, "团队已关闭成员创建知识库");
  }
  const access = input?.access_mode || "team";
  if (!["team", "restricted"].includes(access)) fail(400, "知识库访问范围无效");
  const name = text(input?.name, "知识库名称", 100),
    description = optionalText(input?.description),
    id = randomUUID();
  return transaction(async (client) => {
    const result = await client.query(
      "INSERT INTO spaces(id,name,description,created_by,kind,team_id,access_mode) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        id,
        name,
        description,
        account.id,
        kind,
        teamId,
        kind === "personal" ? "restricted" : access,
      ],
    );
    await client.query(
      "INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'admin')",
      [id, account.id],
    );
    return { ...result.rows[0], role: "admin" };
  });
}
export async function updateSpace(account: User, id: string, input: any) {
  await spaceRole(account, id, "manage");
  const current = (await db.query("SELECT * FROM spaces WHERE id=$1", [id]))
    .rows[0];
  if (input.pinned !== undefined && typeof input.pinned !== "boolean")
    fail(400, "置顶设置无效");
  if (
    input.access_mode !== undefined &&
    !["team", "restricted"].includes(input.access_mode)
  )
    fail(400, "访问范围无效");
  if (input.pinned !== undefined && current.team_id)
    await teamRole(account, current.team_id, true);
  return (
    await db.query(
      "UPDATE spaces SET name=$2,description=$3,pinned=$4,access_mode=$5 WHERE id=$1 RETURNING *",
      [
        id,
        input.name === undefined
          ? current.name
          : text(input.name, "知识库名称", 100),
        input.description === undefined
          ? current.description
          : optionalText(input.description),
        input.pinned ?? current.pinned,
        input.access_mode ?? current.access_mode,
      ],
    )
  ).rows[0];
}
export async function members(account: User, id: string) {
  await spaceRole(account, id);
  return (
    await db.query(
      "SELECT u.id,u.username,u.name,effective_space_role(u.id,s.id) AS role,tm.role AS team_role,(m.user_id IS NULL) AS inherited FROM spaces s JOIN team_members tm ON tm.team_id=s.team_id JOIN users u ON u.id=tm.user_id LEFT JOIN space_members m ON m.user_id=u.id AND m.space_id=s.id WHERE s.id=$1 AND u.active AND effective_space_role(u.id,s.id) IS NOT NULL ORDER BY u.name",
      [id],
    )
  ).rows;
}
export async function setMember(account: User, id: string, input: any) {
  await spaceRole(account, id, "manage");
  if (
    (await db.query("SELECT kind FROM spaces WHERE id=$1", [id])).rows[0]
      .kind === "personal"
  )
    fail(400, "个人知识库不能添加库成员，请在笔记内指定分享成员");
  const userId = identifier(input?.user_id),
    role = input?.role;
  if (!["admin", "editor", "reviewer", "viewer", null].includes(role))
    fail(400, "成员角色无效");
  if (userId === account.id && role !== "admin")
    fail(409, "不能移除自己的知识库管理权限");
  const target = (
    await db.query("SELECT id FROM users WHERE id=$1 AND active=true", [userId])
  ).rows[0];
  if (!target) fail(404, "成员不存在");
  const library = (
    await db.query("SELECT team_id FROM spaces WHERE id=$1", [id])
  ).rows[0];
  if (
    !(
      await db.query(
        "SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2",
        [library.team_id, userId],
      )
    ).rowCount
  )
    fail(400, "请先邀请用户加入团队");
  if (role === null) {
    await transaction(async (client) => {
      await client.query(
        "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
        [id, userId],
      );
      await client.query(
        "UPDATE documents SET access_revision=access_revision+1 WHERE space_id=$1 AND id IN (SELECT doc_id FROM document_collaborators WHERE user_id=$2)",
        [id, userId],
      );
      await client.query(
        "DELETE FROM document_collaborators WHERE user_id=$2 AND doc_id IN (SELECT id FROM documents WHERE space_id=$1)",
        [userId, id],
      );
    });
  } else
    await db.query(
      "INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(space_id,user_id) DO UPDATE SET role=EXCLUDED.role",
      [id, userId, role],
    );
  await db.query(
    "INSERT INTO audit_events(actor,action,target,detail) VALUES($1,$2,$3,$4)",
    [account.id, "space.member", id, { user_id: userId, role }],
  );
  return { ok: true };
}
export async function folders(account: User, id: string) {
  await spaceRole(account, id);
  return (
    await db.query(
      "SELECT * FROM folders WHERE space_id=$1 ORDER BY position,name",
      [id],
    )
  ).rows;
}
export async function createFolder(account: User, id: string, input: any) {
  await spaceRole(account, id, "manage");
  const name = text(input?.name, "目录名称", 100),
    parent = input?.parent_id ? identifier(input.parent_id) : null;
  if (
    parent &&
    !(
      await db.query("SELECT id FROM folders WHERE id=$1 AND space_id=$2", [
        parent,
        id,
      ])
    ).rowCount
  )
    fail(400, "父目录不属于此知识库");
  return (
    await db.query(
      "INSERT INTO folders(id,space_id,parent_id,name) VALUES($1,$2,$3,$4) RETURNING *",
      [randomUUID(), id, parent, name],
    )
  ).rows[0];
}
export async function moveFolder(
  account: User,
  id: string,
  folderId: string,
  input: any,
) {
  await spaceRole(account, id, "manage");
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "anote:folders:" + id,
    ]);
    const folder = (
      await client.query("SELECT * FROM folders WHERE id=$1 AND space_id=$2", [
        folderId,
        id,
      ])
    ).rows[0];
    if (!folder) fail(404, "目录不存在");
    const parent =
      input?.parent_id === undefined
        ? folder.parent_id
        : input.parent_id
          ? identifier(input.parent_id)
          : null;
    if (parent) {
      if (
        !(
          await client.query(
            "SELECT id FROM folders WHERE id=$1 AND space_id=$2",
            [parent, id],
          )
        ).rowCount
      )
        fail(400, "父目录不属于此知识库");
      const ancestors = (
        await client.query(
          "WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM folders WHERE id=$1 UNION ALL SELECT f.id,f.parent_id FROM folders f JOIN ancestors a ON f.id=a.parent_id) SELECT id FROM ancestors",
          [parent],
        )
      ).rows;
      if (ancestors.some((row) => row.id === folderId))
        fail(409, "目录不能移动到自身或下级目录");
    }
    const name =
      input?.name === undefined
        ? folder.name
        : text(input.name, "目录名称", 100);
    return (
      await client.query(
        "UPDATE folders SET name=$1,parent_id=$2 WHERE id=$3 RETURNING *",
        [name, parent, folderId],
      )
    ).rows[0];
  });
}

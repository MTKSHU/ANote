import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { db, digest, transaction } from "./database.js";
import { platformConfig } from "./platform.js";
import { fail, text } from "./errors.js";

export type User = {
  id: string;
  username: string;
  name: string;
  is_admin: boolean;
  role: "editor";
  email?: string | null;
  email_verified?: boolean;
  local_password_enabled?: boolean;
  theme?: "light" | "dark" | "auto";
};
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 ** 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export async function passwordHash(password: string) {
  const salt = randomBytes(16),
    key = await derive(password, salt);
  return (
    "scrypt:65536:8:1:" +
    salt.toString("base64url") +
    ":" +
    key.toString("base64url")
  );
}
async function matches(password: string, encoded: string) {
  const [algorithm, n, r, p, salt, expected] = encoded.split(":");
  if (
    algorithm !== "scrypt" ||
    n !== "65536" ||
    r !== "8" ||
    p !== "1" ||
    !salt ||
    !expected
  )
    return false;
  const key = await derive(password, Buffer.from(salt, "base64url")),
    target = Buffer.from(expected, "base64url");
  return target.length === key.length && timingSafeEqual(target, key);
}
export const publicUser = (row: any): User => ({
  id: row.id,
  username: row.username,
  name: row.name,
  is_admin: row.is_admin,
  role: "editor",
  email: row.email || null,
  email_verified: !!row.email_verified,
  local_password_enabled: row.local_password_enabled !== false,
  theme: row.theme || "auto",
});
const attempts = new Map<string, { count: number; until: number }>();
let dummyHash: string;
export async function bootstrap() {
  dummyHash = await passwordHash(randomBytes(32).toString("hex"));
  if ((await db.query("SELECT 1 FROM users LIMIT 1")).rowCount) return;
  const username = process.env.ADMIN_USERNAME || "admin",
    password = process.env.ADMIN_PASSWORD;
  if (
    !/^[a-zA-Z0-9_.-]{3,64}$/.test(username) ||
    !password ||
    password.length < 16
  )
    throw new Error(
      "Initial setup requires ADMIN_USERNAME and ADMIN_PASSWORD (at least 16 characters)",
    );
  const hash = await passwordHash(password);
  await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('anote:bootstrap'))",
    );
    if ((await client.query("SELECT 1 FROM users LIMIT 1")).rowCount) return;
    const id = randomUUID();
    await client.query(
      "INSERT INTO users(id,username,name,password_hash,is_admin) VALUES($1,$2,$3,$4,true)",
      [id, username.toLowerCase(), "团队管理员", hash],
    );
    const team = randomUUID();
    await client.query(
      "INSERT INTO teams(id,name,created_by) VALUES($1,'研究团队',$2)",
      [team, id],
    );
    await client.query(
      "INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')",
      [team, id],
    );
    const space = randomUUID();
    await client.query(
      "INSERT INTO spaces(id,name,description,created_by,team_id) VALUES($1,$2,$3,$4,$5)",
      [space, "团队知识库", "研究笔记、共享资源与团队协作", id, team],
    );
    await client.query(
      "INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'admin')",
      [space, id],
    );
  });
}
export async function login(request: Request, response: Response, input: any) {
  if (platformConfig().auth_mode === "oidc")
    fail(403, "平台当前仅允许 OIDC 统一认证");
  const username =
      typeof input?.username === "string" ? input.username.toLowerCase() : "",
    password = typeof input?.password === "string" ? input.password : "";
  if (username.length > 64 || password.length > 512)
    fail(401, "用户名或密码不正确");
  const ip = request.ip || request.socket.remoteAddress || "unknown",
    now = Date.now();
  for (const [key, item] of attempts)
    if (item.until < now) attempts.delete(key);
  const attempt = attempts.get(ip) || { count: 0, until: now + 15 * 60 * 1000 };
  if (attempt.count >= 15) fail(429, "登录尝试过多，请稍后重试");
  attempt.count++;
  attempts.set(ip, attempt);
  const account = (
      await db.query("SELECT * FROM users WHERE username=$1", [username])
    ).rows[0],
    valid = await matches(
      password,
      (account?.local_password_enabled ? account.password_hash : dummyHash) ||
        dummyHash,
    );
  if (!account?.active || !valid) fail(401, "用户名或密码不正确");
  attempts.delete(ip);
  return issueSession(account.id, response, account.password_hash);
}
export async function issueSession(
  userId: string,
  response?: Response,
  expectedPasswordHash?: string,
) {
  const token = randomBytes(32).toString("base64url"),
    expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const row = await transaction(async (client) => {
    const account = (
      await client.query(
        "SELECT * FROM users WHERE id=$1 AND active FOR SHARE",
        [userId],
      )
    ).rows[0];
    if (
      !account ||
      (expectedPasswordHash && account.password_hash !== expectedPasswordHash)
    )
      fail(401, "账号或登录凭据已变更，请重新登录");
    await client.query("DELETE FROM sessions WHERE expires_at<now()");
    await client.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [digest(token), userId, expires],
    );
    return account;
  });
  const {onboardingOnVisit}=await import("./onboarding.js");
  await onboardingOnVisit(userId);
  response?.cookie("anote_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    expires,
  });
  return { token, user: publicUser(row) };
}
export function requestToken(req: Request) {
  if (req.headers.authorization?.startsWith("Bearer "))
    return req.headers.authorization.slice(7);
  return (
    (req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("anote_session="))
      ?.slice("anote_session=".length) || ""
  );
}
export async function tokenUser(token: string): Promise<User> {
  if (!/^[\w-]{43}$/.test(token)) fail(401, "请先登录");
  const row = (
    await db.query(
      "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true",
      [digest(token)],
    )
  ).rows[0];
  if (!row) fail(401, "会话已失效，请重新登录");
  return publicUser(row);
}
export async function user(req: Request) {
  return tokenUser(requestToken(req));
}
export async function changeOwnPassword(account: User, input: any) {
  const row = (await db.query("SELECT * FROM users WHERE id=$1", [account.id]))
    .rows[0];
  if (!row.local_password_enabled) fail(400, "OIDC 用户密码由认证服务管理");
  if (
    typeof input?.old_password !== "string" ||
    input.old_password.length > 512 ||
    !(await matches(input.old_password, row.password_hash))
  )
    fail(403, "当前密码不正确");
  if (
    typeof input.password !== "string" ||
    input.password.length < 12 ||
    input.password.length > 512
  )
    fail(400, "新密码需为 12–512 位字符");
  const hash = await passwordHash(input.password);
  await transaction(async (client) => {
    const changed = await client.query(
      "UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3",
      [account.id, hash, row.password_hash],
    );
    if (!changed.rowCount) fail(409, "账号凭据已变化，请重新登录");
    await client.query("DELETE FROM sessions WHERE user_id=$1", [account.id]);
    await client.query(
      "INSERT INTO audit_events(actor,action,target) VALUES($1,'account.password',$1)",
      [account.id],
    );
  });
  return { relogin_required: true };
}
export async function logout(req: Request, res: Response) {
  await db.query("DELETE FROM sessions WHERE token_hash=$1", [
    digest(requestToken(req)),
  ]);
  res.clearCookie("anote_session", { path: "/" });
  return { ok: true };
}
export function administrator(account: User) {
  if (!account.is_admin) fail(403, "仅团队管理员可执行此操作");
}
export async function createUser(account: User, input: any) {
  administrator(account);
  const username = text(input?.username, "用户名", 64).toLowerCase(),
    name = text(input?.name, "成员姓名", 80),
    password = typeof input?.password === "string" ? input.password : "";
  if (
    !/^[a-z0-9_.-]{3,64}$/.test(username) ||
    password.length < 12 ||
    password.length > 512
  )
    fail(400, "用户名需为 3–64 位字母数字，初始密码至少 12 位");
  const hash = await passwordHash(password),
    id = randomUUID();
  try {
    return publicUser(
      (
        await db.query(
          "INSERT INTO users(id,username,name,password_hash,is_admin) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [id, username, name, hash, input.is_admin === true],
        )
      ).rows[0],
    );
  } catch (error) {
    if ((error as any).code === "23505") fail(409, "用户名已存在");
    throw error;
  }
}
export async function spaceRole(
  account: User,
  id: string,
  action: "read" | "create" | "edit" | "comment" | "review" | "manage" = "read",
  sql: Pick<PoolClient,"query"> = db,
) {
  const member = (
    await sql.query(
      "SELECT id,effective_space_role($2,id) AS role FROM spaces WHERE id=$1",
      [id, account.id],
    )
  ).rows[0];
  if (!member) fail(404, "知识库不存在");
  const role = member.role;
  if (!role) fail(403, "无此知识库权限");
  const allowed =
    action === "read" ||
    (action === "create" && ["admin", "editor", "contributor"].includes(role)) ||
    (action === "edit" && ["admin", "editor"].includes(role)) ||
    (action === "comment" && ["admin", "editor", "reviewer", "contributor"].includes(role)) ||
    (action === "review" && ["admin", "reviewer"].includes(role)) ||
    (action === "manage" && role === "admin");
  if (!allowed) fail(403, "当前成员没有此操作权限");
  return role as string;
}
export async function documentRole(
  account: User,
  id: string,
  action: "read" | "edit" | "comment" | "review" | "manage" = "read",
  allowArchived = false,
  allowDeleted = false,
  sql: Pick<PoolClient,"query"> = db,
) {
  const doc = (
    await sql.query(
      `SELECT id,space_id,archived,created_by,visibility,access_revision,deleted_at,deleted_by,${allowDeleted ? "effective_document_role_with_deleted" : "effective_document_role"}($2,id) AS role FROM documents WHERE id=$1`,
      [id, account.id],
    )
  ).rows[0];
  if (!doc) fail(404, "文档不存在");
  if (doc.deleted_at && !allowDeleted) fail(404, "笔记不存在或已移入回收站");
  const role = doc.role;
  if (!role) fail(403, "无此笔记权限");
  if (
    !(
      action === "read" ||
      (action === "edit" && ["admin", "editor"].includes(role)) ||
      (action === "comment" &&
        ["admin", "editor", "reviewer"].includes(role)) ||
      (action === "review" && ["admin", "reviewer"].includes(role)) ||
      (action === "manage" && role === "admin")
    )
  )
    fail(403, "当前成员没有此操作权限");
  if (doc.archived && action === "edit" && !allowArchived)
    fail(409, "归档文档不可编辑");
  if (action === "review" && role === "reviewer") {
    const explicit = await sql.query("SELECT 1 FROM documents d LEFT JOIN document_collaborators c ON c.doc_id=d.id AND c.user_id=$2 WHERE d.id=$1 AND (effective_space_role($2,d.space_id)<>'contributor' OR c.role='reviewer')", [id, account.id]);
    if (!explicit.rowCount) fail(403, "团队默认评论权限不包含审核权限");
  }
  return { ...doc, role };
}
// Only internal aliases/parameter indexes are interpolated here.
export const readableDocumentSQL = (
  alias: string,
  actor = "$1",
  admin = "$2",
) =>
  `(${admin}::boolean IS NOT NULL AND effective_document_role(${actor},${alias}.id) IS NOT NULL)`;

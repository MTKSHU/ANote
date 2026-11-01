import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Controller, Get, Patch, Post, Req, Body } from "@nestjs/common";
import type { Request } from "express";
import { db, transaction, digest } from "./database.js";
import { administrator, user } from "./auth.js";
import { fail, text } from "./errors.js";
import { discoverOIDC, DiscoveryError } from "./oidc-discovery.js";
type Configuration = {
  site_name: string;
  public_origin: string;
  allowed_origins: string[];
  auth_mode: "local" | "oidc" | "both";
  oidc_issuer: string;
  oidc_client_id: string;
  oidc_secret: string;
  oidc_application: string;
  revision: string | number;
};
let current: Configuration;
function key() {
  const value = Buffer.from(
    process.env.SETTINGS_ENCRYPTION_KEY || "",
    "base64url",
  );
  if (value.length !== 32)
    fail(
      503,
      "平台配置加密主密钥未配置，请按部署说明设置 SETTINGS_ENCRYPTION_KEY",
    );
  return value;
}
export function encrypt(value: string) {
  if (!value) return "";
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function decrypt(value: string) {
  if (!value) return "";
  const raw = Buffer.from(value, "base64url"),
    cipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  cipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    cipher.update(raw.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
export function platformConfig() {
  return current;
}
export function oidcConfigurationHash(config: Configuration = current) {
  return digest(
    JSON.stringify([
      config.public_origin,
      config.oidc_issuer,
      config.oidc_client_id,
      config.oidc_secret,
      config.oidc_application,
    ]),
  );
}
export function oidcEnabled() {
  return (
    !!current &&
    current.auth_mode !== "local" &&
    !!(
      current.oidc_issuer &&
      current.oidc_client_id &&
      current.oidc_secret &&
      current.public_origin
    )
  );
}
export async function initializePlatform() {
  const secret = process.env.CASDOOR_CLIENT_SECRET || "";
  await db.query(
    "INSERT INTO platform_settings(singleton,public_origin,oidc_issuer,oidc_client_id,oidc_secret,oidc_application) VALUES(true,$1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [
      process.env.PUBLIC_ORIGIN || "",
      process.env.CASDOOR_SERVER_URL || "",
      process.env.CASDOOR_CLIENT_ID || "",
      secret ? encrypt(secret) : "",
      process.env.CASDOOR_APPLICATION || "",
    ],
  );
  const row = (await db.query("SELECT * FROM platform_settings")).rows[0];
  current = { ...row, oidc_secret: decrypt(row.oidc_secret) };
}
function urlOrigin(value: unknown, label: string, optional = false) {
  if (optional && !value) return "";
  const input = text(value, label, 500);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    fail(400, label + "无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail(400, label + "必须为不含路径的 HTTP(S) 地址");
  return url.origin;
}
function publicSettings() {
  const { oidc_secret, ...safe } = current;
  return {
    ...safe,
    oidc_secret_configured: !!oidc_secret,
    encryption_key_configured: !!process.env.SETTINGS_ENCRYPTION_KEY,
    source: "database",
    oidc_enabled: oidcEnabled(),
    missing_oidc_fields: [
      !current.public_origin && "public_origin",
      !current.oidc_issuer && "oidc_issuer",
      !current.oidc_client_id && "oidc_client_id",
      !current.oidc_secret && "oidc_secret",
    ].filter(Boolean),
  };
}
@Controller("api")
export class PlatformController {
  @Get("platform/public") public() {
    return {
      site_name: current.site_name,
      public_origin: current.public_origin,
      auth_mode: current.auth_mode,
    };
  }
  @Get("admin/settings") async get(@Req() req: Request) {
    administrator(await user(req));
    return publicSettings();
  }
  @Patch("admin/settings") async update(
    @Req() req: Request,
    @Body() input: any,
  ) {
    const actor = await user(req);
    administrator(actor);
    if (!input || typeof input !== "object") fail(400, "配置无效");
    const next = { ...current };
    if (input.site_name !== undefined)
      next.site_name = text(input.site_name, "平台名称", 80);
    if (input.public_origin !== undefined)
      next.public_origin = urlOrigin(input.public_origin, "公共域名");
    if (input.allowed_origins !== undefined) {
      if (
        !Array.isArray(input.allowed_origins) ||
        input.allowed_origins.length > 20
      )
        fail(400, "允许来源无效");
      next.allowed_origins = [
        ...new Set(
          input.allowed_origins.map((v: any) => urlOrigin(v, "允许来源")),
        ),
      ] as string[];
    }
    if (next.public_origin !== current.public_origin && current.public_origin)
      next.allowed_origins = [
        ...new Set([...next.allowed_origins, current.public_origin]),
      ];
    if (input.auth_mode !== undefined) {
      if (!["local", "oidc", "both"].includes(input.auth_mode))
        fail(400, "认证方式无效");
      next.auth_mode = input.auth_mode;
    }
    if (input.oidc_issuer !== undefined)
      next.oidc_issuer = urlOrigin(input.oidc_issuer, "OIDC 服务地址", true);
    if (input.oidc_client_id !== undefined)
      next.oidc_client_id =
        typeof input.oidc_client_id === "string"
          ? input.oidc_client_id.trim()
          : "";
    if (input.oidc_application !== undefined)
      next.oidc_application =
        typeof input.oidc_application === "string"
          ? input.oidc_application.trim()
          : "";
    if (input.oidc_secret) {
      if (
        typeof input.oidc_secret !== "string" ||
        input.oidc_secret.length > 4096
      )
        fail(400, "OIDC 密钥无效");
      next.oidc_secret = input.oidc_secret;
    }
    if (next.oidc_client_id.length > 500 || next.oidc_application.length > 200)
      fail(400, "OIDC 配置长度无效");
    const sameIdentityProvider = [
      "oidc_issuer",
      "oidc_client_id",
      "oidc_secret",
      "oidc_application",
    ].every(
      (key) =>
        next[key as keyof Configuration] ===
        current[key as keyof Configuration],
    );
    if (next.auth_mode === "oidc") {
      if (
        !next.public_origin ||
        !next.oidc_issuer ||
        !next.oidc_client_id ||
        !next.oidc_secret
      )
        fail(400, "仅 OIDC 模式需要完整配置");
      if (
        (current.auth_mode !== "oidc" || !sameIdentityProvider) &&
        !(
          await db.query(
            "SELECT 1 FROM auth_identities i JOIN users u ON u.id=i.user_id WHERE u.id=$1 AND u.active AND u.is_admin AND i.issuer=$2 AND i.validated_configuration=$3",
            [actor.id, next.oidc_issuer, oidcConfigurationHash(next)],
          )
        ).rowCount
      )
        fail(409, "请先让当前平台管理员完成该 OIDC 身份绑定，再关闭本地登录");
    }
    const updated = await transaction(async (client) => {
      // A domain change changes the callback URL, not the proven OIDC identity.
      if (
        sameIdentityProvider &&
        next.public_origin !== current.public_origin
      ) {
        await client.query(
          "UPDATE auth_identities SET validated_configuration=$1 WHERE issuer=$2 AND validated_configuration=$3",
          [
            oidcConfigurationHash(next),
            current.oidc_issuer,
            oidcConfigurationHash(current),
          ],
        );
      }
      const row = (
        await client.query(
          "UPDATE platform_settings SET site_name=$1,public_origin=$2,allowed_origins=$3,auth_mode=$4,oidc_issuer=$5,oidc_client_id=$6,oidc_secret=$7,oidc_application=$8,revision=revision+1,updated_at=now() WHERE revision=$9 RETURNING *",
          [
            next.site_name,
            next.public_origin,
            next.allowed_origins,
            next.auth_mode,
            next.oidc_issuer,
            next.oidc_client_id,
            encrypt(next.oidc_secret),
            next.oidc_application,
            input.revision ?? current.revision,
          ],
        )
      ).rows[0];
      if (!row) fail(409, "配置已被其他管理员修改，请刷新后重试");
      await client.query(
        "INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'platform.settings','platform',$2)",
        [
          actor.id,
          {
            auth_mode: next.auth_mode,
            public_origin: next.public_origin,
            secret_changed: !!input.oidc_secret,
          },
        ],
      );
      return row;
    });
    current = { ...updated, oidc_secret: next.oidc_secret };
    return publicSettings();
  }
  @Post("admin/oidc/check") async check(@Req() req: Request) {
    administrator(await user(req));
    if (!current.oidc_issuer) fail(400, "请先保存 OIDC 服务地址");
    try {
      const result = await discoverOIDC(
        current.oidc_issuer,
        current.oidc_application,
        process.env.CASDOOR_ALLOW_INSECURE_HTTP === "true" &&
          process.env.NODE_ENV !== "production",
      );
      return {
        reachable: true,
        issuer: result.metadata.issuer,
        discovery_url: result.discovery_url,
        fallback_used: result.fallback_used,
        warnings: result.warnings,
        callback_url: current.public_origin + "/api/auth/casdoor/callback",
        credentials_configured: !!(
          current.oidc_client_id && current.oidc_secret
        ),
      };
    } catch (error) {
      fail(
        400,
        error instanceof DiscoveryError
          ? error.message
          : "无法读取 OIDC discovery，请检查服务地址与容器网络",
      );
    }
  }
  @Get("admin/audit") async audit(@Req() req: Request) {
    administrator(await user(req));
    return (
      await db.query(
        "SELECT a.id,a.action,a.target,a.detail,a.created_at,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 200",
      )
    ).rows;
  }
}

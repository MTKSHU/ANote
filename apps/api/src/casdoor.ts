import { Controller, Get, Post, Req, Res, Body } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { db, digest, transaction } from "./database.js";
import { user, requestToken, issueSession } from "./auth.js";
import { fail } from "./errors.js";
import { discoverOIDC } from "./oidc-discovery.js";
import {
  platformConfig,
  oidcEnabled,
  oidcConfigurationHash,
} from "./platform.js";

const random = () => randomBytes(32).toString("base64url");
const validRandom = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{43}$/.test(value);
const testHTTP = () =>
  process.env.CASDOOR_ALLOW_INSECURE_HTTP === "true" &&
  process.env.NODE_ENV !== "production";
const startAttempts = new Map<string, { count: number; until: number }>();
function limitStart(req: Request) {
  const now = Date.now();
  for (const [key, item] of startAttempts)
    if (item.until < now) startAttempts.delete(key);
  const key = req.ip || req.socket.remoteAddress || "unknown",
    entry = startAttempts.get(key) || { count: 0, until: now + 5 * 60 * 1000 };
  if (
    entry.count >= 200 ||
    (!startAttempts.has(key) && startAttempts.size >= 2048)
  )
    fail(429, "统一登录请求过多，请稍后重试");
  entry.count++;
  startAttempts.set(key, entry);
}
function origin(value: string | undefined, label: string) {
  if (!value) throw new Error(label + " missing");
  const url = new URL(value);
  if (
    url.origin !== value.replace(/\/$/, "") ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(testHTTP() && url.protocol === "http:"))
  )
    throw new Error(label + " invalid");
  return url.origin;
}
function settings() {
  const cfg = platformConfig();
  return {
    server: origin(cfg.oidc_issuer, "OIDC issuer"),
    public: origin(cfg.public_origin, "Public origin"),
    client: cfg.oidc_client_id,
    secret: cfg.oidc_secret,
    application: cfg.oidc_application,
  };
}
function available() {
  try {
    const s = settings();
    return oidcEnabled() && !!(s.client && s.secret);
  } catch {
    return false;
  }
}
function callbackURL() {
  return settings().public + "/api/auth/casdoor/callback";
}
let configuration: Promise<oidc.Configuration> | undefined;
let configurationRevision: string | number;
async function provider() {
  if (!available()) fail(503, "Casdoor 尚未配置完成");
  if (configurationRevision !== platformConfig().revision) {
    configuration = undefined;
    configurationRevision = platformConfig().revision;
  }
  if (!configuration)
    configuration = (async () => {
      const s = settings();
      const { metadata } = await discoverOIDC(
        s.server,
        s.application,
        testHTTP(),
      );
      const config = new oidc.Configuration(
        metadata,
        s.client,
        { client_secret: s.secret },
        oidc.ClientSecretPost(s.secret),
      );
      config.timeout = 10;
      if (testHTTP()) oidc.allowInsecureRequests(config);
      oidc.enableNonRepudiationChecks(config);
      return config;
    })().catch((error) => {
      configuration = undefined;
      throw error;
    });
  return configuration;
}
function loopback(input: unknown) {
  if (typeof input !== "string") fail(400, "客户端回调地址无效");
  const url = new URL(input);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) < 1024 ||
    !url.port ||
    url.pathname !== "/callback" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    fail(400, "客户端回调地址无效");
  return url.href;
}
type StartRequest = {
  actor_id?: string;
  session_hash?: string;
  native_redirect?: string;
  native_challenge?: string;
  native_state?: string;
};
async function ticket(input: StartRequest) {
  const value = random();
  await db.query(
    "INSERT INTO oidc_requests(ticket_hash,actor_id,session_hash,native_redirect,native_challenge,native_state) VALUES($1,$2,$3,$4,$5,$6)",
    [
      digest(value),
      input.actor_id || null,
      input.session_hash || null,
      input.native_redirect || null,
      input.native_challenge || null,
      input.native_state || null,
    ],
  );
  return settings().public + "/api/auth/casdoor/start?ticket=" + value;
}
function cookieName(state: string) {
  return "anote_oidc_" + state.slice(0, 12);
}
function browserCookie(req: Request, state: string) {
  return (
    (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName(state) + "="))
      ?.split("=")[1] || ""
  );
}
async function cleanup() {
  for (const table of ["oidc_requests", "oidc_attempts", "oidc_grants"])
    await db.query(`DELETE FROM ${table} WHERE expires_at<now()`);
}
// Stable identity is (issuer, subject). Never infer account ownership from a name/email or provider admin flag.
class IdentityError extends Error {}
async function identity(
  issuer: string,
  subject: string,
  profile: oidc.UserInfoResponse,
  request: StartRequest,
) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      issuer + "|" + subject,
    ]);
    const existing = (
      await client.query(
        "SELECT u.* FROM auth_identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=$1 AND i.subject=$2",
        [issuer, subject],
      )
    ).rows[0];
    if (request.actor_id) {
      const actor = (
        await client.query(
          "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>now() AND u.active FOR UPDATE OF u",
          [request.session_hash, request.actor_id],
        )
      ).rows[0];
      if (!actor) fail(401, "绑定会话已过期");
      if (existing && existing.id !== actor.id)
        fail(409, "此 Casdoor 身份已绑定其他账号");
      const email =
        typeof profile.email === "string"
          ? profile.email.trim().toLowerCase()
          : "";
      if (profile.email_verified === true && email) {
        if (
          (
            await client.query(
              "SELECT 1 FROM users WHERE lower(email)=$1 AND email_verified AND id<>$2",
              [email, actor.id],
            )
          ).rowCount
        )
          throw new IdentityError("email_conflict");
        await client.query(
          "UPDATE users SET email=$2,email_verified=true WHERE id=$1",
          [actor.id, email],
        );
      }
      if (!existing)
        await client.query(
          "INSERT INTO auth_identities(issuer,subject,user_id) VALUES($1,$2,$3)",
          [issuer, subject, actor.id],
        );
      await client.query(
        "INSERT INTO audit_events(actor,action,target) VALUES($1,'auth.casdoor.link',$1)",
        [actor.id],
      );
      return actor;
    }
    if (existing) return existing;
    const email =
      typeof profile.email === "string"
        ? profile.email.trim().toLowerCase()
        : "";
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))
      throw new IdentityError("email_required");
    if (profile.email_verified !== true)
      throw new IdentityError("email_unverified");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "email:" + email,
    ]);
    const match = (
      await client.query(
        "SELECT * FROM users WHERE lower(email)=$1 AND email_verified FOR UPDATE",
        [email],
      )
    ).rows[0];
    if (match) {
      if (
        (
          await client.query(
            "SELECT 1 FROM auth_identities WHERE issuer=$1 AND user_id=$2",
            [issuer, match.id],
          )
        ).rowCount
      )
        throw new IdentityError("email_conflict");
      await client.query(
        "INSERT INTO auth_identities(issuer,subject,user_id) VALUES($1,$2,$3)",
        [issuer, subject, match.id],
      );
      await client.query(
        "INSERT INTO audit_events(actor,action,target) VALUES($1,'auth.email.link',$1)",
        [match.id],
      );
      return match;
    }
    const id = randomUUID(),
      name = String(
        profile.name || profile.preferred_username || "Casdoor 成员",
      ).slice(0, 80);
    const created = (
      await client.query(
        "INSERT INTO users(id,username,name,password_hash,local_password_enabled,active,membership_status,email,email_verified) VALUES($1,$2,$3,'sso-only',false,true,'active',$4,true) RETURNING *",
        [id, "sso-" + id, name, email],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO auth_identities(issuer,subject,user_id) VALUES($1,$2,$3)",
      [issuer, subject, id],
    );
    await client.query(
      "INSERT INTO audit_events(actor,action,target) VALUES(NULL,'auth.casdoor.create',$1)",
      [id],
    );
    return created;
  });
}
function finish(
  res: Response,
  request: StartRequest,
  error?: string,
  code?: string,
) {
  res.setHeader("Referrer-Policy", "no-referrer");
  if (request.native_redirect) {
    const dest = new URL(request.native_redirect);
    dest.searchParams.set("state", request.native_state!);
    if (error) dest.searchParams.set("error", error);
    if (code) dest.searchParams.set("code", code);
    res.redirect(303, dest.href);
  } else
    res.redirect(
      303,
      settings().public +
        "/?" +
        (error ? "auth_error=" + error : "auth_success=casdoor"),
    );
}

@Controller("api/auth")
export class CasdoorController {
  @Get("providers") providers() {
    return {
      local: platformConfig().auth_mode !== "oidc",
      casdoor: {
        enabled: available(),
        start_url: available()
          ? settings().public + "/api/auth/casdoor/start"
          : null,
      },
    };
  }
  @Get("identities") async identities(@Req() req: Request) {
    const account = await user(req);
    return {
      casdoor_linked: !!(
        await db.query("SELECT 1 FROM auth_identities WHERE user_id=$1", [
          account.id,
        ])
      ).rowCount,
      enabled: available(),
    };
  }
  @Post("casdoor/link") async link(@Req() req: Request) {
    if (!available()) fail(503, "Casdoor 尚未配置完成");
    const account = await user(req);
    return {
      url: await ticket({
        actor_id: account.id,
        session_hash: digest(requestToken(req)),
      }),
    };
  }
  @Post("casdoor/native/start") async nativeStart(
    @Req() req: Request,
    @Body() body: any,
  ) {
    limitStart(req);
    if (!available()) fail(503, "Casdoor 尚未配置完成");
    if (
      !validRandom(body?.code_challenge) ||
      !validRandom(body?.state) ||
      ![undefined, "login", "link"].includes(body.intent)
    )
      fail(400, "客户端登录参数无效");
    const request: StartRequest = {
      native_redirect: loopback(body.redirect_uri),
      native_challenge: body.code_challenge,
      native_state: body.state,
    };
    if (body.intent === "link") {
      request.actor_id = (await user(req)).id;
      request.session_hash = digest(requestToken(req));
    }
    await cleanup();
    return { url: await ticket(request) };
  }
  @Get("casdoor/start") async start(@Req() req: Request, @Res() res: Response) {
    if (!available()) fail(503, "Casdoor 尚未配置完成");
    limitStart(req);
    // A one-time hop pins the browser origin even when a reverse proxy rewrites Host/protocol.
    // Do not infer the callback origin from request or forwarded headers.
    if (req.query.ticket === undefined) {
      await cleanup();
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(await ticket({}));
      return;
    }
    let request: StartRequest = {};
    if (req.query.ticket !== undefined) {
      if (!validRandom(req.query.ticket)) fail(400, "登录请求无效");
      const stored = (
        await db.query(
          "DELETE FROM oidc_requests WHERE ticket_hash=$1 AND expires_at>now() RETURNING *",
          [digest(req.query.ticket)],
        )
      ).rows[0];
      if (!stored) fail(400, "登录请求已过期，请重新开始");
      request = {
        actor_id: stored.actor_id,
        session_hash: stored.session_hash,
        native_redirect: stored.native_redirect,
        native_challenge: stored.native_challenge,
        native_state: stored.native_state,
      };
    }
    try {
      const config = await provider(),
        state = random(),
        binding = random(),
        verifier = oidc.randomPKCECodeVerifier(),
        nonce = oidc.randomNonce();
      await cleanup();
      await db.query(
        "INSERT INTO oidc_attempts(state_hash,browser_hash,verifier,nonce,request) VALUES($1,$2,$3,$4,$5)",
        [
          digest(state),
          digest(binding),
          verifier,
          nonce,
          JSON.stringify(request),
        ],
      );
      res.cookie(cookieName(state), binding, {
        httpOnly: true,
        sameSite: "lax",
        secure: settings().public.startsWith("https:"),
        path: "/api/auth/casdoor",
        maxAge: 5 * 60 * 1000,
      });
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(
        oidc.buildAuthorizationUrl(config, {
          redirect_uri: callbackURL(),
          scope: "openid profile email",
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        }).href,
      );
    } catch {
      finish(res, request, "provider_unavailable");
    }
  }
  @Get("casdoor/callback") async callback(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!available()) fail(503, "Casdoor 尚未配置完成");
    const state = req.query.state;
    if (!validRandom(state)) {
      finish(res, {}, "invalid_response");
      return;
    }
    const binding = browserCookie(req, state);
    res.clearCookie(cookieName(state), { path: "/api/auth/casdoor" });
    const attempt = (
      await db.query(
        "DELETE FROM oidc_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *",
        [digest(state), digest(binding)],
      )
    ).rows[0];
    if (!attempt) {
      finish(res, {}, "invalid_response");
      return;
    }
    const request = attempt.request as StartRequest;
    try {
      const config = await provider();
      const current = new URL(callbackURL());
      current.search = new URL(req.originalUrl, "http://internal").search;
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        expectedState: state,
        expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub || claims.sub.length > 512)
        throw new Error("Missing subject");
      const profile = await oidc.fetchUserInfo(
        config,
        tokens.access_token,
        claims.sub,
      );
      const account = await identity(
        settings().server,
        claims.sub,
        {
          ...profile,
          email: profile.email ?? claims.email,
          email_verified:
            profile.email_verified ??
            (profile.email === undefined ||
            (typeof profile.email === "string" &&
              typeof claims.email === "string" &&
              profile.email.trim().toLowerCase() ===
                claims.email.trim().toLowerCase())
              ? claims.email_verified
              : false),
        } as oidc.UserInfoResponse,
        request,
      );
      await db.query(
        "UPDATE auth_identities SET validated_configuration=$3 WHERE issuer=$1 AND subject=$2",
        [settings().server, claims.sub, oidcConfigurationHash()],
      );
      if (!account.active) {
        finish(
          res,
          request,
          account.membership_status === "pending" ? "pending" : "disabled",
        );
        return;
      }
      if (request.native_redirect) {
        const code = random();
        await db.query(
          "INSERT INTO oidc_grants(code_hash,user_id,challenge) VALUES($1,$2,$3)",
          [digest(code), account.id, request.native_challenge],
        );
        finish(res, request, undefined, code);
      } else {
        await issueSession(account.id, res);
        finish(res, request);
      }
    } catch (error) {
      finish(
        res,
        request,
        error instanceof IdentityError ? error.message : "invalid_response",
      );
    }
  }
  @Post("casdoor/native/exchange") async exchange(@Body() body: any) {
    if (!available()) fail(503, "Casdoor 尚未配置完成");
    if (!validRandom(body?.code) || !validRandom(body?.code_verifier))
      fail(400, "客户端登录凭据无效");
    const challenge = await oidc.calculatePKCECodeChallenge(body.code_verifier);
    const grant = (
      await db.query(
        "DELETE FROM oidc_grants WHERE code_hash=$1 AND challenge=$2 AND expires_at>now() RETURNING user_id",
        [digest(body.code), challenge],
      )
    ).rows[0];
    if (!grant) fail(401, "客户端登录凭据已过期或无效");
    return issueSession(grant.user_id);
  }
}

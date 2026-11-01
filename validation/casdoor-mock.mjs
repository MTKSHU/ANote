// Isolated OIDC integration fixture. Never include this service in the NAS deployment.
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomBytes, createHash } from "node:crypto";
const issuer = "http://casdoor-mock:4400";
const keys = await generateKeyPair("RS256"),
  other = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: "test-key",
  use: "sig",
  alg: "RS256",
};
let profile = {
  sub: "mock-user",
  name: "测试成员",
  preferred_username: "admin",
  email: "admin@example.test",
  mode: "normal",
};
const codes = new Map(),
  access = new Map();
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (code, value) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8192) {
        json(413, {});
        return;
      }
    }
    if (url.pathname === "/control" && req.method === "POST") {
      profile = JSON.parse(raw);
      profile.email ??= profile.sub + "@example.test";
      json(200, { ok: true });
      return;
    }
    if (url.pathname.endsWith("/openid-configuration")) {
      if(url.pathname.includes('/denied-app/')){json(200,{status:'error',msg:'Unauthorized operation'});return;}
      if(url.pathname.includes('/missing-app/')){json(404,{});return;}
      json(200, {
        issuer:url.pathname.includes('/wrong-issuer-app/')?'https://wrong-issuer.example.test':issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        userinfo_endpoint: issuer + "/userinfo",
        jwks_uri: issuer + "/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/jwks") {
      json(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === "/authorize") {
      if (
        url.searchParams.get("client_id") !== "test-client" ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        json(400, { error: "invalid_request" });
        return;
      }
      const code = randomBytes(24).toString("hex");
      codes.set(code, {
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
        redirect: url.searchParams.get("redirect_uri"),
        profile: { ...profile },
      });
      const dest = new URL(url.searchParams.get("redirect_uri"));
      dest.searchParams.set("state", url.searchParams.get("state"));
      dest.searchParams.set("code", code);
      res.writeHead(302, { Location: dest.href });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      const input = new URLSearchParams(raw),
        stored = codes.get(input.get("code"));
      codes.delete(input.get("code"));
      if (
        input.get("client_id") !== "test-client" ||
        input.get("client_secret") !== "test-secret" ||
        !stored ||
        stored.redirect !== input.get("redirect_uri") ||
        createHash("sha256")
          .update(input.get("code_verifier") || "")
          .digest("base64url") !== stored.challenge
      ) {
        json(400, { error: "invalid_grant" });
        return;
      }
      const p = stored.profile,
        token = randomBytes(32).toString("base64url");
      access.set(token, p);
      const id = await new SignJWT({
        sub: p.sub,
        ...(p.mode === "email_mismatch"
          ? { email: "different-verified@example.test", email_verified: true }
          : {}),
        nonce: p.mode === "nonce" ? "wrong" : stored.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(p.mode === "issuer" ? "http://wrong.test" : issuer)
        .setAudience(p.mode === "audience" ? "other-client" : "test-client")
        .setIssuedAt()
        .setExpirationTime(p.mode === "expired" ? "-1h" : "5m")
        .sign(p.mode === "signature" ? other.privateKey : keys.privateKey);
      json(200, {
        access_token: token,
        token_type: "Bearer",
        expires_in: 300,
        id_token: id,
      });
      return;
    }
    if (url.pathname === "/userinfo") {
      const p = access.get((req.headers.authorization || "").slice(7));
      if (!p) {
        json(401, {});
        return;
      }
      json(200, {
        sub: p.mode === "subject" ? "wrong" : p.sub,
        name: p.name,
        preferred_username: p.preferred_username,
        email: p.mode === "email_missing" ? undefined : p.email,
        email_verified:
          p.mode === "email_mismatch"
            ? undefined
            : p.mode !== "email_unverified" && p.verified !== false,
        isAdmin: true,
      });
      return;
    }
    json(404, {});
  })
  .listen(4400, "0.0.0.0");

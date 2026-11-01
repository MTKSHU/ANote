import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discoverOIDC } from "../../apps/api/src/oidc-discovery.ts";
const original = globalThis.fetch,
  issuer = "https://identity.example.test",
  standard = issuer + "/.well-known/openid-configuration",
  scoped = issuer + "/.well-known/research/openid-configuration";
const metadata = {
  issuer,
  authorization_endpoint: issuer + "/authorize",
  token_endpoint: issuer + "/token",
  jwks_uri: issuer + "/jwks",
  userinfo_endpoint: issuer + "/userinfo",
};
afterEach(() => {
  globalThis.fetch = original;
});
function mock(fn: (url: string) => Response | Promise<Response>) {
  const visited: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    visited.push(url);
    return fn(url);
  }) as typeof fetch;
  return visited;
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
test("standard discovery uses the issuer and publishes no warning", async () => {
  const calls = mock(() => json(metadata));
  const result = await discoverOIDC(issuer);
  assert.equal(result.fallback_used, false);
  assert.equal(result.discovery_url, standard);
  assert.deepEqual(calls, [standard]);
});
test("valid application discovery retains its own key set", async () => {
  const calls = mock(() =>
    json({ ...metadata, jwks_uri: issuer + "/.well-known/research/jwks" }),
  );
  const result = await discoverOIDC(issuer, "research");
  assert.equal(result.metadata.jwks_uri, issuer + "/.well-known/research/jwks");
  assert.equal(result.fallback_used, false);
  assert.deepEqual(calls, [scoped]);
});
test("HTTP 200 Unauthorized operation envelope falls back and explains the effective URL", async () => {
  const calls = mock((url) =>
    url === scoped
      ? json({ status: "error", msg: "Unauthorized operation" })
      : json(metadata),
  );
  const result = await discoverOIDC(issuer, "research");
  assert.equal(result.fallback_used, true);
  assert.equal(result.discovery_url, standard);
  assert.match(result.warnings[0], /Unauthorized operation/);
  assert.deepEqual(calls, [scoped, standard]);
});
test("missing application route falls back to standard metadata", async () => {
  mock((url) => (url === scoped ? json({}, 404) : json(metadata)));
  assert.equal((await discoverOIDC(issuer, "research")).fallback_used, true);
});
test("an HTML application login page is not mistaken for metadata", async () => {
  mock((url) =>
    url === scoped ? new Response("<html>login</html>") : json(metadata),
  );
  assert.equal((await discoverOIDC(issuer, "research")).fallback_used, true);
});
test("issuer mismatch does not downgrade to the standard document", async () => {
  const calls = mock(() =>
    json({ ...metadata, issuer: "https://wrong.example.test" }),
  );
  await assert.rejects(discoverOIDC(issuer, "research"), /issuer/);
  assert.deepEqual(calls, [scoped]);
});
test("insecure or cross-origin endpoints do not trigger fallback", async () => {
  const calls = mock(() =>
    json({ ...metadata, token_endpoint: "http://attacker.example.test/token" }),
  );
  await assert.rejects(discoverOIDC(issuer, "research"), /token_endpoint/);
  assert.deepEqual(calls, [scoped]);
});
test("incomplete metadata is reported precisely", async () => {
  mock(() => json({ ...metadata, userinfo_endpoint: undefined }));
  await assert.rejects(discoverOIDC(issuer), /userinfo_endpoint/);
});
test("a failing standard endpoint remains an error after an application refusal", async () => {
  mock(() => json({ status: "error", msg: "Unauthorized operation" }));
  await assert.rejects(discoverOIDC(issuer, "research"), /拒绝匿名访问/);
});
test("TLS failures are reported without weakening transport validation", async () => {
  mock(() => {
    throw new TypeError("fetch failed", {
      cause: { code: "CERT_HAS_EXPIRED" },
    });
  });
  await assert.rejects(discoverOIDC(issuer), /证书校验失败/);
});

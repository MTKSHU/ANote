import type { ServerMetadata } from "openid-client";

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly fallbackEligible = false,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}
export type DiscoveryResult = {
  metadata: ServerMetadata;
  discovery_url: string;
  fallback_used: boolean;
  warnings: string[];
};

async function read(
  url: string,
  issuer: string,
  allowHTTP: boolean,
): Promise<ServerMetadata> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
  } catch (error) {
    const cause = (error as any).cause?.code;
    if (
      (error as Error).name === "TimeoutError" ||
      (error as Error).name === "AbortError"
    )
      throw new DiscoveryError(
        "OIDC discovery 连接超时，请检查容器到认证服务的网络",
      );
    if (typeof cause === "string" && /CERT|TLS|SSL/.test(cause))
      throw new DiscoveryError(
        "OIDC discovery 的 HTTPS 证书校验失败，请检查认证服务的证书链",
      );
    throw new DiscoveryError(
      "无法连接 OIDC discovery，请检查服务地址、DNS 及容器网络",
    );
  }
  if (!response.ok)
    throw new DiscoveryError(
      `OIDC discovery 返回 HTTP ${response.status}`,
      [401, 403, 404, 405, 500, 502, 503].includes(response.status),
    );
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new DiscoveryError(
      "OIDC discovery 未返回 JSON 元数据，可能是登录页或未开放的地址",
      true,
    );
  }
  if (data?.status === "error" || data?.error) {
    throw new DiscoveryError(
      data?.msg === "Unauthorized operation"
        ? "OIDC discovery 拒绝匿名访问（Unauthorized operation）"
        : "OIDC discovery 返回了服务端错误，未提供元数据",
      true,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new DiscoveryError("OIDC discovery 文档格式无效");
  if (data.issuer !== issuer)
    throw new DiscoveryError(
      "OIDC discovery 返回的 issuer 与配置的服务地址不一致",
    );
  for (const name of [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "userinfo_endpoint",
  ]) {
    if (typeof data[name] !== "string")
      throw new DiscoveryError(`OIDC discovery 缺少 ${name}`);
    let endpoint: URL;
    try {
      endpoint = new URL(data[name]);
    } catch {
      throw new DiscoveryError(`OIDC discovery 的 ${name} 地址无效`);
    }
    if (
      endpoint.origin !== new URL(issuer).origin ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      (endpoint.protocol !== "https:" &&
        !(allowHTTP && endpoint.protocol === "http:"))
    )
      throw new DiscoveryError(
        `OIDC discovery 的 ${name} 需要使用认证服务同源的安全地址`,
      );
  }
  return data as ServerMetadata;
}

/** Prefer an application certificate when published. Only unavailable application metadata
 * may fall back to the issuer's standard document; validation errors never fall back. */
export async function discoverOIDC(
  issuer: string,
  application = "",
  allowHTTP = false,
): Promise<DiscoveryResult> {
  const standard = issuer + "/.well-known/openid-configuration";
  if (!application)
    return {
      metadata: await read(standard, issuer, allowHTTP),
      discovery_url: standard,
      fallback_used: false,
      warnings: [],
    };
  const scoped =
    issuer +
    "/.well-known/" +
    encodeURIComponent(application) +
    "/openid-configuration";
  try {
    return {
      metadata: await read(scoped, issuer, allowHTTP),
      discovery_url: scoped,
      fallback_used: false,
      warnings: [],
    };
  } catch (error) {
    if (!(error instanceof DiscoveryError) || !error.fallbackEligible)
      throw error;
    const metadata = await read(standard, issuer, allowHTTP);
    return {
      metadata,
      discovery_url: standard,
      fallback_used: true,
      warnings: [
        "应用级发现地址不可用，已使用标准 discovery。" +
          error.message +
          "。若应用使用独立签名证书，请开放对应的应用级 discovery 和 JWKS 地址。",
      ],
    };
  }
}

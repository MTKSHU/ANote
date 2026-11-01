import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { serverOrigin } from "./session-store.mjs";
import { getLocale, t } from "@anote/i18n";
const messages = {
  pending: "加入申请已提交，请联系团队管理员批准后重新登录。",
  disabled: "账号已停用，请联系团队管理员。",
  invalid_response: "统一登录未完成或已过期，请重新开始。",
  provider_unavailable: "暂时无法连接 Casdoor，请稍后重试。",
};
export class CasdoorLogin {
  constructor(openExternal) {
    this.openExternal = openExternal;
    this.cancel = null;
  }
  async providers(serverURL) {
    const origin = serverOrigin(serverURL);
    const response = await fetch(origin + "/api/auth/providers", {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("无法读取服务的登录配置");
    return response.json();
  }
  async connect(input, token) {
    if (this.connecting)
      throw new Error("已有统一登录正在进行，请完成或取消后重试");
    this.connecting = true;
    try {
      return await this.run(input, token);
    } finally {
      this.connecting = false;
    }
  }
  async run({ serverURL, intent = "login" }, token) {
    if (this.cancel)
      throw new Error("已有统一登录正在进行，请完成或取消后重试");
    const origin = serverOrigin(serverURL);
    if (!["login", "link"].includes(intent)) throw new Error("登录参数无效");
    if (intent === "link" && !token) throw new Error("请先登录需要绑定的账号");
    const providers = await this.providers(origin);
    if (!providers.casdoor?.enabled) throw new Error("此服务尚未配置 Casdoor");
    const start = new URL(providers.casdoor.start_url);
    if (
      !["https:", "http:"].includes(start.protocol) ||
      start.pathname !== "/api/auth/casdoor/start" ||
      start.username ||
      start.password ||
      start.search ||
      start.hash
    )
      throw new Error("登录配置无效");
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let timer;
    const completion = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancel = null;
        server.close();
        server.closeAllConnections();
        error ? reject(error) : resolve(result);
      };
      this.cancel = () => finish(new Error("已取消统一登录"));
      timer = setTimeout(
        () => finish(new Error("统一登录已超时，请重试")),
        180000,
      );
      timer.unref();
      let received = false;
      server.on("request", async (req, res) => {
        let url;
        try {
          url = new URL(req.url, "http://127.0.0.1");
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        if (
          req.method !== "GET" ||
          url.pathname !== "/callback" ||
          url.searchParams.get("state") !== state ||
          received
        ) {
          res.writeHead(400);
          res.end();
          return;
        }
        received = true;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
          "Referrer-Policy": "no-referrer",
        });
        res.end(
          `<!doctype html><html lang="${getLocale()}"><meta charset=utf-8><title>ANote</title><p>${t("登录请求已处理，请返回 ANote 客户端。")}</p></html>`,
        );
        try {
          const error = url.searchParams.get("error");
          if (error)
            throw new Error(messages[error] || "统一登录未完成，请重试");
          const code = url.searchParams.get("code");
          if (!code || !/^[-\w]{43}$/.test(code))
            throw new Error("登录返回无效");
          const response = await fetch(
            origin + "/api/auth/casdoor/native/exchange",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code, code_verifier: verifier }),
              signal: AbortSignal.timeout(10000),
              redirect: "error",
            },
          );
          const result = await response.json();
          if (!response.ok || !result.token || !result.user?.id)
            throw new Error(result.error || "登录交换失败");
          finish(null, result);
        } catch (error) {
          finish(error);
        }
      });
    });
    // Observe rejection while opening the browser, including cancellation before start returns.
    completion.catch(() => {});
    try {
      const response = await fetch(origin + "/api/auth/casdoor/native/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(intent === "link" ? { Authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify({
          redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
          state,
          code_challenge: challenge,
          intent,
        }),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法开始统一登录");
      const url = new URL(result.url);
      if (
        url.origin !== start.origin ||
        url.pathname !== start.pathname ||
        url.username ||
        url.password ||
        url.hash ||
        !/^[\w-]{43}$/.test(url.searchParams.get("ticket") || "") ||
        url.searchParams.size !== 1
      )
        throw new Error("登录地址无效");
      if (!this.cancel) return await completion;
      await this.openExternal(url.href);
    } catch (error) {
      this.cancel?.();
      throw error;
    }
    return completion;
  }
}

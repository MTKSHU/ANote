import { t as translateUI } from "@anote/i18n";
import {MediaViewerHost} from "../../desktop/renderer/media-viewer";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { NotebookWorkspace } from "../../desktop/renderer/workspace";
import type { NativeState, User } from "../../desktop/renderer/native";
import "@anote/editor/style.css";
import "../../desktop/renderer/style.css";
import "./style.css";
import { PublicNote } from "../../desktop/renderer/sharing";
import { McpConsent } from "./mcp-consent";
import { LanguageSelect } from "../../desktop/renderer/language";
import "../../desktop/renderer/note-theme.css";
import "../../desktop/renderer/workspace.css";
import "../../desktop/renderer/themes.css";
import "../../desktop/renderer/ui-system.css";
import { initializeTheme } from "../../desktop/renderer/theme";
initializeTheme();

type Session = {
  user: User & { username: string; is_admin: boolean };
  token: string;
};
type Space = { id: string; name: string; description: string; role: string };
type Folder = { id: string; name: string; parent_id: string | null };
async function api(endpoint: string, method = "GET", body?: any) {
  const response = await fetch("/api/" + endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(translateUI(value.error || value.message || "请求失败")), {
      status: response.status,
    });
  return value;
}
function App() {
  const [mcpRequest,setMcpRequest]=useState("");
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [authNotice, setAuthNotice] = useState(
      authMessage(new URLSearchParams(location.search).get("auth_error")),
    );
  useEffect(() => {
    if (session) {
      const url = new URL(location.href);
      url.searchParams.delete("auth_error");
      url.searchParams.delete("auth_success");
      history.replaceState(null, "", url);
    }
  }, [session]);
  useEffect(()=>{
    if(!session)return;
    let current=true;
    void api("me/integrations/pending").then(value=>{if(current)setMcpRequest(value.id||"");}).catch(()=>{});
    return ()=>{current=false;};
  },[session?.user.id]);
  useEffect(() => {
    const invitation = new URLSearchParams(location.search).get("invite");
    if (invitation && /^[\w-]{43}$/.test(invitation))
      sessionStorage.setItem("pending_team_invite", invitation);
    api("auth/session")
      .then(setSession)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  if (location.pathname.startsWith("/share/"))
    return <PublicNote token={location.pathname.split("/")[2]} />;
  if (loading) return <div className="launching">{translateUI("正在打开研究空间…")}</div>;
  return session ? (
    <>
      <Workspace session={session} onLogout={() => setSession(null)} />
      {mcpRequest&&<McpConsent id={mcpRequest} userName={session.user.name} onClosed={()=>{setMcpRequest("");history.replaceState(null,"","/");}}/>}
      {authNotice && (
        <div className="auth-result" role="alert">
          <span>{authNotice}</span>
          <button aria-label={translateUI("关闭登录提示")} onClick={() => setAuthNotice("")}>
            ×
          </button>
        </div>
      )}
    </>
  ) : (
    <Login
      onConnected={(next) => {
        setAuthNotice("");
        setSession(next);
      }}
    />
  );
}
function authMessage(code: string | null) {
  const messages: Record<string, string> = {
    email_required: translateUI("认证服务未返回有效邮箱，请先在认证服务补充邮箱。"),
    email_unverified: translateUI("请先在认证服务验证邮箱后重新登录。"),
    email_conflict: translateUI("此邮箱或身份已关联其他账号，请联系平台管理员核对。"),
    pending: translateUI("加入申请已提交，请联系团队管理员批准后重新登录。"),
    disabled: translateUI("账号已停用，请联系团队管理员。"),
    invalid_response:
      translateUI("统一登录未完成或已过期，请重试；已有账号请先本地登录后绑定 Casdoor。"),
    provider_unavailable: translateUI("暂时无法连接 Casdoor，请稍后重试或使用本地账号。"),
  };
  return code ? messages[code] || translateUI("统一登录未完成，请重试。") : "";
}
function Login({ onConnected }: { onConnected: (session: Session) => void }) {
  const [siteName, setSiteName] = useState("ANote");
  useEffect(() => { void api("platform/public").then(value => { setSiteName(value.site_name); document.title = value.site_name; }).catch(() => {}); }, []);
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [provider, setProvider] = useState<any>(null),
    [localEnabled, setLocalEnabled] = useState(true),
    [error, setError] = useState(
      authMessage(new URLSearchParams(location.search).get("auth_error")),
    ),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api("auth/providers")
      .then((value) => {
        setProvider(value.casdoor);
        setLocalEnabled(value.local !== false);
      })
      .catch(() => {});
  }, []);
  return (
    <div className="web-login">
      <section className="login-story">
        <div className="wordmark">{siteName}</div>
        <h1>{translateUI("团队笔记")}</h1>
        <p>{translateUI("记录、协作与分享。")}</p>
      </section>
      <form
        className="web-login-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            onConnected(
              await api("auth/login", "POST", { username, password }),
            );
          } catch (error) {
            setError(translateUI((error as Error).message));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{translateUI("登录")}</h2>
        <LanguageSelect />
        <p>{translateUI("使用团队成员账号登录。")}</p>
        {provider?.enabled && (
          <a className="sso-login" href={provider.start_url}>{translateUI("使用 Casdoor 统一登录 ")}</a>
        )}
        {provider?.enabled && localEnabled && (
          <p className="muted">{translateUI("或使用本地账号")}</p>
        )}
        {localEnabled && (
          <>
            <label>{translateUI("用户名 ")}<input
                aria-label={translateUI("用户名")}
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>{translateUI("密码 ")}<input
                aria-label={translateUI("密码")}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button className="primary wide" disabled={busy}>
              {busy ? translateUI("正在登录…") : translateUI("登录")}
            </button>
          </>
        )}
        {!localEnabled && !provider?.enabled && (
          <p role="alert">{translateUI("统一认证尚未配置完成，请联系平台管理员。")}</p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </form>
    </div>
  );
}

function Workspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const state: NativeState = {
    desktop: false,
    stateRevision: 0,
    serverURL: location.origin,
    user: session.user,
    token: session.token,
    offline: false,
    workspace: "",
    lastDoc: null,
    credentialWarning: "",
    sync: { running: false, pending: [], documents: [] },
  };
  return (
    <NotebookWorkspace
      state={state}
      onLogout={async () => {
        await api("auth/logout", "POST");
        onLogout();
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(<><App /><MediaViewerHost/></>);

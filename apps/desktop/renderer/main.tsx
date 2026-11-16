import { t as translateUI } from "@anote/i18n";
import { getLocale as uiLanguage } from "@anote/i18n";
import { LanguageSelect } from "./language";
import {MediaViewerHost} from "./media-viewer";
import {BrandLogo} from "./brand";
import {ClientUpdateBanner} from "./client-updates";
import {StorageMigrationOverlay} from "./client-storage";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { NotebookWorkspace } from "./workspace";
import { Document } from "./document";
import { request, type NativeState } from "./native";
import {useDialog} from "./dialog";
import "./connection-guide.css";
import "@anote/editor/style.css";
import "./style.css";
import "../../web/src/style.css";
import "./note-theme.css";
import "./workspace.css";
import "./themes.css";
import "./ui-system.css";
import "./mobile-workspace.css";
import { initializeTheme } from "./theme";
initializeTheme();

function App() {
  useEffect(() => { void window.anote.setLocale(uiLanguage()); }, []);
  const [state, setState] = useState<NativeState | null>(null),
    [documents, setDocuments] = useState<any[]>([]),
    [selected, setSelected] = useState<string | null>(
      new URLSearchParams(location.search).get("doc"),
    ),
    [search, setSearch] = useState(""),
    [showConnect, setShowConnect] = useState(false),
    [error, setError] = useState("");
  const identity = useRef("");
  const initialDocument = useRef(
    new URLSearchParams(location.search).get("doc"),
  );
  const lastRevision = useRef(-1);
  const pendingWorkspace=useRef<{scope?:string;page?:"home"|"friends"|"teams"}|null>(null);
  function closeConnectionDialog(){pendingWorkspace.current=null;setShowConnect(false);}
  const connectionDialog=useDialog<HTMLDivElement>(closeConnectionDialog,{open:showConnect});
  function connected(next:NativeState){
    const target=pendingWorkspace.current;pendingWorkspace.current=null;
    acceptState(next);setShowConnect(false);
    if(target&&!next.personal)void window.anote.openServerWorkspace?.(target).catch(error=>setError(translateUI((error as Error).message)));
  }
  function acceptState(next: NativeState) {
    if (next.stateRevision < lastRevision.current) return;
    lastRevision.current = next.stateRevision;
    const key = next.user ? next.serverURL + "|" + next.user.id : "";
    if (identity.current && identity.current !== key) {
      setDocuments([]);
      setSelected(next.lastDoc);
      setError("");
      history.replaceState(null,"",next.lastDoc ? "/?doc="+encodeURIComponent(next.lastDoc) : "/");
    }
    identity.current = key;
    if (next.personal) initialDocument.current = null;
    if (next.user && initialDocument.current) {
      const id = initialDocument.current;
      initialDocument.current = null;
      setSelected(id);
      void window.anote.selectDocument(id,key);
    }
    setState(next);
  }
  useEffect(() => {
    window.anote.state().then((s) => {
      acceptState(s);
      setSelected((v) => v || s.lastDoc);
    });
    return window.anote.onState(acceptState);
  }, []);
  useEffect(()=>{if(state)void window.anote.rendererReady?.().catch(()=>{});},[!!state]);
  useEffect(() => {
    const connect = (event:Event) => {pendingWorkspace.current=(event as CustomEvent).detail?.workspace||null;setShowConnect(true);};
    window.addEventListener("anote-connect-server", connect);
    return () => window.removeEventListener("anote-connect-server", connect);
  }, []);
  async function refresh() {
    const key = identity.current;
    try {
      const next = await request("documents");
      if (identity.current === key) setDocuments(next);
    } catch (e) {
      if (identity.current === key) setError(translateUI((e as Error).message));
    }
  }
  useEffect(() => {
    if (state?.user) void refresh();
  }, [state?.user?.id, state?.serverURL, state?.offline]);
  useEffect(() => {
    const changed = () => {
      if (state?.user) void refresh();
    };
    window.addEventListener("anote-note-changed", changed);
    return () => window.removeEventListener("anote-note-changed", changed);
  }, [state?.user?.id, state?.serverURL]);
  if (!state) return <div className="launching">{translateUI("正在打开 ANote…")}</div>;
  if (!state.user)
    return (
      <Connect
        initial={state}
        startTeam={showConnect}
        onConnected={connected}
      />
    );
  if (!state.validationMode)
    return (
      <>
        <NotebookWorkspace
          key={state.serverURL + ":" + state.user.id}
          state={state}
          onLogout={async () => {
            history.replaceState(null, "", "/");
            acceptState(await window.anote.logout());
          }}
          onReconnect={()=>{pendingWorkspace.current=null;setShowConnect(true);}}
        />
        {showConnect && (
          <div className="modal">
            <div className="modal-shell" ref={connectionDialog} role="dialog" aria-label={translateUI("连接服务器")}>
              <button
                className="modal-close"
                aria-label={translateUI("关闭")}
                onClick={closeConnectionDialog}
              >
                ×
              </button>
              <Connect
                initial={state}
                startTeam
                onConnected={connected}
              />
            </div>
          </div>
        )}
      </>
    );
  const active = documents.find((d) => d.id === selected),
    visible = documents.filter((d) =>
      d.title.toLowerCase().includes(search.toLowerCase()),
    ),
    pending = state.sync.pending.length;
  return (
    <div className="desktop-app">
      <aside className="sidebar">
        <div className="desktop-brand">
          <span className="brand-logo-frame"><BrandLogo size={39}/></span>
          <div>
            <strong>ANote</strong>
            <small>{translateUI("ANote · 研究空间")}</small>
          </div>
        </div>
        <button className="space-switch" onClick={() => setShowConnect(true)}>
          <span>◈</span>
          <div>
            <b>{state.validationMode ? translateUI("研究验证空间") : translateUI("课题组知识空间")}</b>
            <small>{new URL(state.serverURL).hostname}</small>
          </div>
          <span>⌄</span>
        </button>
        <p className="nav-label">{translateUI("工作台")}</p>
        <button className="nav-item active">
          <span>▤</span>{translateUI("研究笔记 ")}<small>{documents.length}</small>
        </button>
        <div className="sidebar-divider" />
        <div className="notes-label">
          <span>{translateUI("我的文档")}</span>
          <button
            title={translateUI("新建笔记")}
            disabled={state.offline || state.user.role !== "editor"}
            onClick={async () => {
              try {
                const doc = await request("documents", "POST", {
                  title: translateUI("未命名研究笔记"),
                });
                await refresh();
                setSelected(doc.id);
                await window.anote.selectDocument(doc.id,identity.current);
              } catch (e) {
                setError(translateUI((e as Error).message));
              }
            }}
          >
            ＋
          </button>
        </div>
        <div className="note-links">
          {visible.map((d) => (
            <button
              key={d.id}
              className={selected === d.id ? "selected" : ""}
              onClick={() => {
                setSelected(d.id);
                void window.anote.selectDocument(d.id,identity.current);
              }}
            >
              <span>▧</span>
              <b>{d.title}</b>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className="workspace-button"
            onClick={async () => {
              try {
                await window.anote.chooseWorkspace();
              } catch (e) {
                setError(translateUI((e as Error).message));
              }
            }}
          >
            <span>▱</span>
            <div>
              <b>{translateUI("本地工作目录")}</b>
              <small>{state.workspace || translateUI("选择保存笔记的文件夹")}</small>
            </div>
          </button>
          <button
            className="offline-toggle"
            onClick={() => void window.anote.offline(!state.offline)}
          >
            <span className={state.offline ? "dot offline" : "dot"} />
            {state.offline ? translateUI("离线模式") : translateUI("在线同步")}
            <small>{state.offline ? translateUI("恢复连接") : translateUI("切换离线")}</small>
          </button>
          <div className="user-line">
            <span>{state.user.name.slice(0, 1)}</span>
            <div>
              <b>{state.user.name}</b>
              <small>
                {pending ? translateUI("{0} 个同步任务待处理", [pending]) : translateUI("工作空间已就绪")}
              </small>
            </div>
          </div>
          {state.credentialWarning && (
            <small className="credential-note" role="status">
              {state.credentialWarning}
            </small>
          )}
        </div>
      </aside>
      <div className="desktop-content">
        <div className="desktop-topbar">
          <div>
            <span>{translateUI("研究工作台")}</span>
            <i>/</i>
            <b>{translateUI("笔记与知识")}</b>
          </div>
          <label className="search">
            ⌕{" "}
            <input
              value={search}
              placeholder={translateUI("搜索笔记…")}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span className="app-version">{translateUI("桌面开发版")}</span>
        </div>
        {selected ? (
          <Document
            key={`${state.serverURL}:${state.user.id}:${selected}:${state.token || "offline"}`}
            state={state}
            id={selected}
            title={active?.title || translateUI("研究笔记")}
          />
        ) : (
          <div className="welcome">
            <p className="kicker">YOUR RESEARCH, CONNECTED</p>
            <h1>{translateUI("让灵感有迹可循， ")}<br />{translateUI("让研究持续生长。 ")}</h1>
            <p>{translateUI("打开一份研究笔记，连接团队的知识与本地工作目录。")}</p>
            <div className="welcome-cards">
              <div>
                ◧<h3>{translateUI("完整的研究表达")}</h3>
                <p>{translateUI("富文本、增强表格与多图对比")}</p>
              </div>
              <div>
                ↔<h3>{translateUI("连在一起的知识")}</h3>
                <p>{translateUI("实时协作、评论与历史版本")}</p>
              </div>
              <div>
                ▱<h3>{translateUI("离线也能继续")}</h3>
                <p>{translateUI("本地缓存、Markdown 与重连同步")}</p>
              </div>
            </div>
          </div>
        )}
        {error && (
          <div className="global-notice">
            <span>{error}</span>
            <button onClick={() => setError("")}>×</button>
          </div>
        )}
        <footer>
          <span>{state.offline ? translateUI("○ 离线工作") : translateUI("● 已连接研究空间")}</span>
          <span>{translateUI("Electron · 共享 React 编辑器")}</span>
        </footer>
      </div>
      {showConnect && (
        <div className="modal">
          <div className="modal-shell" ref={connectionDialog} role="dialog" aria-label={translateUI("连接服务器")}>
            <button
              className="modal-close"
              onClick={closeConnectionDialog}
            >
              ×
            </button>
            <Connect
              initial={state}
              startTeam
              onConnected={(s)=>{connected(s);void refresh();}}
            />
          </div>
        </div>
      )}
    </div>
  );
}
function Connect({
  initial,
  onConnected,
  startTeam = false,
}: {
  initial: NativeState;
  onConnected: (s: NativeState) => void;
  startTeam?: boolean;
}) {
  const [serverURL, setURL] = useState(
      (/^https?:\/\//.test(initial.serverURL)?initial.serverURL:initial.connectionServerURL) || import.meta.env.VITE_ANOTE_SERVER_URL || "",
    ),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ssoEnabled, setSSOEnabled] = useState(false),
    [localEnabled, setLocalEnabled] = useState(false),
    [providerState,setProviderState]=useState<"loading"|"ready"|"error">("loading"),
    [providerRetry,setProviderRetry]=useState(0),
    [ssoBusy, setSSOBusy] = useState(false),
    [connectMode, setConnectMode] = useState(
      initial.user || startTeam ? "team" : "choose",
    );
  useEffect(() => {
    if (startTeam) setConnectMode("team");
  }, [startTeam]);
  useEffect(() => {
    if (connectMode !== "team") return;
    let current = true;
    setSSOEnabled(false);
    // A new origin must not inherit another service's authentication policy.
    setLocalEnabled(false);setProviderState("loading");setError("");
    const timer = setTimeout(() => {
      void window.anote
        .casdoorProviders(serverURL)
        .then((info) => {
          if (current) {
            setSSOEnabled(info.casdoor.enabled);
            setLocalEnabled(info.local !== false);
            setProviderState("ready");
          }
        })
        .catch(error=>{if(current){setProviderState("error");setError(translateUI(connectionError(error)));}});
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [serverURL, connectMode,providerRetry]);
  useEffect(
    () => () => {
      void window.anote.cancelCasdoor();
    },
    [],
  );
  if (connectMode === "choose")
    return (
      <div className="connect-screen">
        <section className="connect-card">
          <div className="connect-brand"><BrandLogo size={42}/></div>
          <h1>ANote</h1>
          <LanguageSelect />
          <p>{translateUI("连接服务器使用已有笔记，或选择目录开始本地记录。")}</p>
          <button className="primary wide" disabled={busy} onClick={()=>{setError("");setConnectMode("team");}}>{translateUI("连接服务器")}</button>
          <p className="muted">{translateUI("输入服务地址，登录后访问个人与团队知识库。")}</p>
          <button
            className="wide"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onConnected(await window.anote.enterPersonal());
              } catch (e) {
                setError(translateUI(connectionError(e)));
              } finally {
                setBusy(false);
              }
            }}
          >{translateUI("本地个人笔记 ")}</button>
          <p className="muted">{translateUI("无需账号和服务器，笔记与附件保存在自己的目录。 ")}</p>
          {error && <p role="alert">{error}</p>}
        </section>
      </div>
    );
  return (
    <div className="connect-screen">
      <form
        className="connect-card"
        onSubmit={async (e) => {
          e.preventDefault();
          if(providerState!=="ready"||!localEnabled||busy||ssoBusy)return;
          setBusy(true);
          setError("");
          try {
            onConnected(
              await window.anote.connect({ serverURL, username, password }),
            );
          } catch (e) {
            setError(translateUI(connectionError(e)));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="connect-brand"><BrandLogo size={42}/></div>
        <p className="kicker">{translateUI("ANote · 桌面客户端")}</p>
        <h1>{translateUI("连接服务器")}</h1>
        <LanguageSelect />
        <p>{initial.personal?translateUI("登录成功后切换到服务器笔记。本地笔记保留在原目录，不会自动上传。"):translateUI("输入 ANote 服务地址，登录后访问个人与团队知识库。")}</p>
        <button
          type="button"
          className="wide"
          disabled={busy||ssoBusy}
          onClick={() => setConnectMode("choose")}
        >{translateUI("返回使用方式 ")}</button>
        <label>{translateUI("服务地址 ")}<input
            aria-label={translateUI("服务地址")}
            type="url"
            value={serverURL}
            onChange={(e) => setURL(e.target.value)}
            disabled={ssoBusy||busy}
            required
          />
        </label>
        {ssoEnabled && (
          <button
            className="primary wide"
            type="button"
            disabled={busy || ssoBusy}
            onClick={async () => {
              setSSOBusy(true);
              setError("");
              try {
                onConnected(
                  await window.anote.connectCasdoor({ serverURL }),
                );
              } catch (error) {
                setError(translateUI(connectionError(error)));
              } finally {
                setSSOBusy(false);
              }
            }}
          >
            {ssoBusy ? translateUI("请在浏览器中完成统一登录…") : translateUI("使用 Casdoor 统一登录")}
          </button>
        )}
        {ssoBusy && (
          <button
            type="button"
            onClick={() => void window.anote.cancelCasdoor()}
          >{translateUI("取消统一登录 ")}</button>
        )}
        {localEnabled && (
          <>
            <label>{translateUI("用户名 ")}<input
                aria-label={translateUI("用户名")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>{translateUI("密码 ")}<input
                aria-label={translateUI("密码")}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button className="primary wide" disabled={busy || ssoBusy}>
              {busy ? translateUI("正在连接…") : translateUI("登录并连接")}
            </button>
          </>
        )}
        {providerState==="loading"&&<p role="status">{translateUI("正在读取服务器登录方式…")}</p>}
        {providerState==="error"&&<button className="wide" type="button" onClick={()=>setProviderRetry(value=>value+1)}>{translateUI("重新读取登录方式")}</button>}
        {providerState==="ready"&&!localEnabled && !ssoEnabled && (
          <p role="alert">{translateUI("统一认证尚未配置完成，请联系平台管理员。")}</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <small>{translateUI("关闭或取消登录会保留当前笔记，登录成功后才切换连接。")}</small>
      </form>
    </div>
  );
}
function connectionError(error:unknown){return (error instanceof Error?error.message:String(error)).replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/,"");}
createRoot(document.getElementById("root")!).render(<><App /><MediaViewerHost/><ClientUpdateBanner/><StorageMigrationOverlay/></>);

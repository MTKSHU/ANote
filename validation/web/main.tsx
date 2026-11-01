import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useResearchEditor, ResearchEditorContent } from "@anote/editor";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { findAnchor } from "../shared/anchors";
import { newId } from "../shared/id";
import "./style.css";

type Session = {
  token: string;
  user: { id: string; name: string; role: string };
};
const colors: Record<string, string> = {
  alice: "#34715d",
  bob: "#c67840",
  carol: "#596ec6",
  viewer: "#7c8190",
};
let currentSession: Session | null = null;
async function api(path: string, method = "GET", body?: any) {
  const response = await fetch("/api/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(currentSession
        ? { Authorization: `Bearer ${currentSession.token}` }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || value.message || "操作失败"), {
      status: response.status,
      value,
    });
  return value;
}

function Workspace({ session, docId }: { session: Session; docId: string }) {
  const [status, setStatus] = useState("connecting"),
    [synced, setSynced] = useState(false),
    [members, setMembers] = useState<any[]>([]);
  const provider = useMemo(() => {
    const document = new Y.Doc();
    return new HocuspocusProvider({
      url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`,
      name: docId,
      document,
      token: session.token,
      onStatus: ({ status }) => setStatus(status),
      onSynced: () => setSynced(true),
      onAwarenessUpdate: ({ states }) =>
        setMembers(states.filter((s: any) => s.user)),
      onAuthenticationFailed: ({ reason }) => setStatus("鉴权失败：" + reason),
    });
  }, [docId, session.token]);
  useEffect(
    () => () => {
      provider.destroy();
      provider.document.destroy();
    },
    [provider],
  );
  return (
    <div className="app">
      <header>
        <div className="brand-mark">A</div>
        <div>
          <strong>ANote</strong>
          <p>协同编辑与双向同步 · 验证工作台</p>
        </div>
        <div className="header-right">
          <span
            className={`connection ${status === "connected" ? "online" : ""}`}
            data-testid="connection"
          >
            {status === "connected" ? "● 实时连接" : status}
          </span>
          <span
            className="user-badge"
            style={{ background: colors[session.user.id] || "#657" }}
          >
            {session.user.name.slice(0, 1)}
          </span>
          <div>
            <b>{session.user.name}</b>
            <small>
              {session.user.role === "editor"
                ? "编辑者"
                : session.user.role === "reviewer"
                  ? "审核者"
                  : "只读成员"}
            </small>
          </div>
          <button
            onClick={() => {
              localStorage.removeItem("anote-session");
              location.href = "/";
            }}
          >
            切换身份
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">RESEARCH IN SYNC</p>
            <h1>让每一次修改，都有据可循。</h1>
            <p>在同一份研究文档中，验证协作、增强内容与本地笔记的连接。</p>
          </div>
          <div className="avatars">
            {members.map((m: any) => (
              <span
                key={m.clientId}
                style={{ background: m.user.color }}
                title={m.user.name}
              >
                {m.user.name?.slice(0, 1)}
              </span>
            ))}
            <small data-testid="member-count">{members.length} 人在线</small>
          </div>
        </div>
        <div className="scenario-strip">
          <span>
            <b>01</b> 多人实时协作
          </span>
          <span>
            <b>02</b> 增强表格与多图保真
          </span>
          <span>
            <b>03</b> Markdown 三方合并
          </span>
        </div>
        {synced ? (
          <EditorWorkspace
            session={session}
            docId={docId}
            provider={provider}
          />
        ) : (
          <div className="loading">正在同步文档…</div>
        )}
        <footer>
          本地验证原型 · React / NestJS / PostgreSQL / Yjs · 所有运行与测试均在
          Docker 中
        </footer>
      </main>
    </div>
  );
}

function EditorWorkspace({
  session,
  docId,
  provider,
}: {
  session: Session;
  docId: string;
  provider: HocuspocusProvider;
}) {
  const [markdown, setMarkdown] = useState(""),
    [base, setBase] = useState<any>(null),
    [message, setMessage] = useState(""),
    [conflicts, setConflicts] = useState<any[]>([]),
    [comments, setComments] = useState<any[]>([]),
    [reviews, setReviews] = useState<any[]>([]),
    [tab, setTab] = useState("sync"),
    [quote, setQuote] = useState("场景重建"),
    [comment, setComment] = useState(""),
    [pending, setPending] = useState(false);
  const editable = session.user.role === "editor";
  const editor = useResearchEditor({
    document: provider.document,
    provider,
    editable,
    user: { ...session.user, color: colors[session.user.id] },
    onUpdate: () => setMessage("文档变化已进入实时协作通道"),
  });

  async function refresh() {
    try {
      const [c, r] = await Promise.all([
        api(`documents/${docId}/comments`),
        api(`documents/${docId}/reviews`),
      ]);
      setComments(c);
      setReviews(r);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [docId]);
  useEffect(() => {
    if (!editor) return;
    (window as any).__lab = {
      editor,
      provider,
      ydoc: provider.document,
      getJSON: () => editor.getJSON(),
      findAnchor: (text: string) => findAnchor(provider.document, text),
      refresh,
    };
    return () => {
      delete (window as any).__lab;
    };
  }, [editor, provider]);
  async function exportMD() {
    try {
      const data = await api(`documents/${docId}/export`);
      setBase(data);
      setMarkdown(data.markdown);
      setConflicts([]);
      setMessage("已生成带基准版本的本地 Markdown");
      return data;
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  async function importMD() {
    setPending(true);
    try {
      const result = await api(`documents/${docId}/import`, "POST", {
        markdown,
        opId: newId(),
      });
      setConflicts([]);
      setMessage(
        `合并成功：更新 ${result.changed.length} 个普通块，增强内容保留`,
      );
      await refresh();
    } catch (e: any) {
      setConflicts(e.value?.conflicts || []);
      setMessage(
        e.value?.conflicts
          ? "发现冲突：线上内容未被覆盖，本地内容已保留"
          : e.message,
      );
    } finally {
      setPending(false);
    }
  }
  async function addComment() {
    const anchor = findAnchor(provider.document, quote);
    if (!anchor) {
      setMessage("未找到这段文字，请选择文档中的原文");
      return;
    }
    try {
      await api(`documents/${docId}/comments`, "POST", {
        text: comment,
        anchor,
      });
      setComment("");
      setMessage("评论已保存");
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  async function submit() {
    try {
      await api(`documents/${docId}/reviews`, "POST", {});
      setMessage("已提交当前版本快照，后续编辑不会改变该快照");
      setTab("review");
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  async function decision(id: string, status: string) {
    try {
      await api(`documents/${docId}/reviews/${id}/decision`, "POST", {
        status,
        comment: status === "approved" ? "验证通过" : "请补充实验说明",
      });
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  if (!editor) return null;
  return (
    <>
      <div className="workspace-grid">
        <section className="document-card">
          <div className="doc-topline">
            <span>
              团队知识库 <i>/</i> 三维重建 <i>/</i> 验证文档
            </span>
            <button className="primary" disabled={!editable} onClick={submit}>
              提交审核 ↗
            </button>
          </div>
          <div className="editor-toolbar">
            <button
              title="加粗"
              disabled={!editable}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <b>B</b>
            </button>
            <button
              title="斜体"
              disabled={!editable}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <i>I</i>
            </button>
            <span />
            <button
              disabled={!editable}
              onClick={() => editor.chain().focus().addRowAfter().run()}
            >
              ＋ 行
            </button>
            <button
              disabled={!editable}
              onClick={() => editor.chain().focus().addColumnAfter().run()}
            >
              ＋ 列
            </button>
            <button
              disabled={!editable}
              onClick={() => editor.chain().focus().mergeCells().run()}
            >
              合并单元格
            </button>
            <button
              disabled={!editable}
              onClick={() => editor.chain().focus().splitCell().run()}
            >
              拆分
            </button>
            <small>自动同步</small>
          </div>
          <ResearchEditorContent editor={editor} />
          <div className="doc-footnote">
            增强表格保留合并、列宽与富文本；多图节点保留对比视图和参数。
          </div>
        </section>
        <aside className="side-card">
          <div className="side-tabs">
            <button
              className={tab === "sync" ? "active" : ""}
              onClick={() => setTab("sync")}
            >
              Markdown 同步
            </button>
            <button
              className={tab === "review" ? "active" : ""}
              onClick={() => setTab("review")}
            >
              评论与审核 <em>{comments.length}</em>
            </button>
          </div>
          {tab === "sync" ? (
            <div className="side-content">
              <div className="section-label">
                本地兼容层 <span>三方合并</span>
              </div>
              <p>
                导出后修改普通段落，再回传。增强块保持结构；重叠修改进入冲突队列。
              </p>
              <div className="sync-actions">
                <button onClick={() => void exportMD()}>↓ 获取基准</button>
                <label className="file-button">
                  打开 .md
                  <input
                    type="file"
                    accept=".md,text/markdown"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) setMarkdown(await file.text());
                    }}
                  />
                </label>
                <button
                  disabled={!base}
                  onClick={() => {
                    const blob = new Blob([markdown], {
                        type: "text/markdown",
                      }),
                      a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "研究笔记.md";
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  下载
                </button>
              </div>
              <textarea
                aria-label="本地 Markdown"
                data-testid="markdown"
                className="markdown-input"
                spellCheck={false}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder="点击「获取基准」，开始双向同步验证…"
              />
              <button
                className="primary full"
                disabled={!editable || !markdown || pending}
                onClick={importMD}
              >
                {pending ? "正在比较…" : "↑ 合并回协作文档"}
              </button>
              {base && <small className="base-id">基准：{base.baseId}</small>}
              {conflicts.length > 0 && (
                <div className="conflict-box" data-testid="conflicts">
                  <b>内容已保留，请处理冲突</b>
                  {conflicts.map((c, i) => (
                    <p key={i}>
                      <code>{c.blockId}</code> {c.reason}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="side-content">
              <div className="section-label">
                文档评论 <span>{comments.length} 条</span>
              </div>
              <input
                aria-label="评论引用原文"
                placeholder="引用文档中的一段文字"
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
              />
              <textarea
                aria-label="评论内容"
                placeholder="留下问题、观察或建议…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <button
                disabled={!comment || session.user.role === "viewer"}
                onClick={addComment}
              >
                添加评论
              </button>
              <div className="comments">
                {comments.map((c) => (
                  <article key={c.id}>
                    <b>{c.author}</b>
                    <blockquote>
                      {c.resolvedAnchor.orphaned
                        ? "引用内容已删除"
                        : c.resolvedAnchor.text}
                    </blockquote>
                    <p>{c.body}</p>
                    <small>
                      {c.resolvedAnchor.orphaned
                        ? "锚点失效，线程保留"
                        : "相对位置锚点有效"}
                    </small>
                  </article>
                ))}
              </div>
              <div className="section-label review-heading">
                审核快照 <span>{reviews.length} 个</span>
              </div>
              {reviews.map((r) => (
                <article className="review" key={r.id}>
                  <b>
                    {r.status === "pending"
                      ? "待审核"
                      : r.status === "approved"
                        ? "已通过"
                        : "已退回"}
                  </b>
                  <p>
                    提交人 {r.submitter} · 审核人 {r.reviewer}
                  </p>
                  <code>{r.hash.slice(0, 16)}…</code>
                  {r.status === "pending" &&
                    session.user.role === "reviewer" && (
                      <div>
                        <button onClick={() => void decision(r.id, "approved")}>
                          通过
                        </button>
                        <button onClick={() => void decision(r.id, "rejected")}>
                          退回
                        </button>
                      </div>
                    )}
                </article>
              ))}
            </div>
          )}
        </aside>
      </div>
      <div
        className={`status-message ${conflicts.length ? "warning" : ""}`}
        role="status"
        data-testid="status-message"
      >
        {message ||
          "协作文档已就绪。可以在另一个浏览器使用不同身份打开同一文档。"}
      </div>
    </>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(() => {
      try {
        return JSON.parse(localStorage.getItem("anote-session") || "null");
      } catch {
        return null;
      }
    }),
    [user, setUser] = useState(
      new URLSearchParams(location.search).get("user") || "alice",
    ),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [docs, setDocs] = useState<any[]>([]);
  const docId = new URLSearchParams(location.search).get("doc");
  currentSession = session;
  useEffect(() => {
    if (session && !docId)
      api("documents")
        .then(setDocs)
        .catch((e) => setError(e.message));
  }, [session, docId]);
  if (session && docId) return <Workspace session={session} docId={docId} />;
  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="brand-mark">A</div>
        <p className="eyebrow">ANote VALIDATION</p>
        <h1>一起验证，放心协作。</h1>
        <p>这是隔离的技术验证空间，使用预设身份和本地验证口令。</p>
        {!session ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const s = await api("session", "POST", {
                  user,
                  secret: password,
                });
                localStorage.setItem("anote-session", JSON.stringify(s));
                setSession(s);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              验证身份
              <select value={user} onChange={(e) => setUser(e.target.value)}>
                <option value="alice">林一 · 编辑者</option>
                <option value="bob">周可 · 编辑者</option>
                <option value="carol">陈默 · 审核者</option>
                <option value="viewer">只读成员</option>
              </select>
            </label>
            <label>
              验证口令
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="primary full">进入验证空间</button>
          </form>
        ) : (
          <>
            <button
              className="primary full"
              disabled={session.user.role !== "editor"}
              onClick={async () => {
                try {
                  const doc = await api("documents", "POST", {
                    title: "协同链路验证",
                  });
                  location.href = `/?doc=${doc.id}`;
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              新建验证文档
            </button>
            <div className="doc-list">
              {docs.map((d) => (
                <a href={`/?doc=${d.id}`} key={d.id}>
                  {d.title}
                  <small>{d.id.slice(0, 8)} ↗</small>
                </a>
              ))}
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <small>口令位于 validation/.env；未部署到云端。</small>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

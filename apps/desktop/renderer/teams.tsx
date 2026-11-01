import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { request as api, type User } from "./native";

import { Icon } from "./icons";
import { useDialog, DialogClose } from "./dialog";
type Props = {
  user: User;
  teamId: string;
  serverURL: string;
  onSelect: (id: string) => void;
  onOpenLibrary: (id: string) => void;
  librariesContent: React.ReactNode;
  libraryViewControls: React.ReactNode;
  libraries: any[];
  documents: any[];
  onNewLibrary: () => void;
  initialTab?: string;
  onOpenNote: (id: string) => void;
  onChanged: () => Promise<void>;
  onDeleteTeam: (team: { id: string; name: string }) => void;
  onError: (e: unknown) => void;
};
export function TeamsHub({
  user,
  teamId,
  serverURL,
  onSelect,
  onOpenLibrary,
  librariesContent, libraryViewControls, libraries, documents, onNewLibrary, initialTab = "home",
  onOpenNote,
  onChanged,
  onDeleteTeam,
  onError,
}: Props) {
  const viewKey = `anote:team-view:${serverURL}:${user.id}`;
  const [view, setView] = useState<"cards" | "list">(() => {
    try { return localStorage.getItem(viewKey) === "list" ? "list" : "cards"; } catch { return "cards"; }
  });
  function chooseView(next: "cards" | "list") {
    setView(next);
    try { localStorage.setItem(viewKey, next); } catch {}
  }
  const [teams, setTeams] = useState<any[]>([]),
    [team, setTeam] = useState<any>(null),
    [tab, setTab] = useState("home"),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [email, setEmail] = useState(""),
    [invite, setInvite] = useState(""),
    [inviteReusable, setInviteReusable] = useState(true),
    [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle"),
    [inviting, setInviting] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const inviteInput = useRef<HTMLInputElement>(null);
  const copyContext = useRef({teamId, invite});
  copyContext.current = {teamId, invite};
  useEffect(() => { setCopyState("idle"); }, [teamId, invite]);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = setTimeout(() => setCopyState("idle"), 2200);
    return () => clearTimeout(timer);
  }, [copyState]);
  async function copyInvite() {
    if (copyState === "copying") return;
    const context = copyContext.current;
    setCopyState("copying");
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(context.invite);
      else {
        inviteInput.current?.focus();
        inviteInput.current?.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
      }
      if (copyContext.current.teamId === context.teamId && copyContext.current.invite === context.invite) setCopyState("copied");
    } catch {
      if (copyContext.current.teamId === context.teamId && copyContext.current.invite === context.invite) setCopyState("error");
    }
  }
  async function refresh() {
    setTeams(await api("teams"));
    if (teamId) {
      const next = await api("teams/" + teamId);
      setTeam(next);

    }
  }
  useEffect(() => {
    setTeam(null);
    setTab(initialTab);
    setInvite("");
    setCreating(false);
    void refresh().catch(onError);
  }, [teamId]);
  async function update(input: any) {
    setBusy(true);
    try {
      await api("teams/" + teamId, "PATCH", input);
      await refresh();
      await onChanged();
      setNotice(translateUI("团队设置已保存"));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  if (!teamId)
    return (
      <div className="academic-browser team-hub">
        <header className="team-heading">
          <div>
            <h1>{translateUI("我的团队")}</h1>
          </div>
          <div className="team-header-actions">
          <div className="team-view-controls" role="group" aria-label={translateUI("团队显示方式")}>
            <button aria-label={translateUI("卡片视图")} aria-pressed={view === "cards"} onClick={() => chooseView("cards")}><Icon name="table" />{translateUI("卡片")}</button>
            <button aria-label={translateUI("列表视图")} aria-pressed={view === "list"} onClick={() => chooseView("list")}><Icon name="list" />{translateUI("列表")}</button>
          </div>
          <button
            className="primary"
            onClick={() => {
              setCreating(true);
              setName("");
              setDescription("");
            }}
          >{translateUI("创建团队 ")}</button>
          </div>
        </header>
        {creating && (
          <form
            className="management-form team-card"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const created = await api("teams", "POST", {
                  name,
                  description,
                });
                await onChanged();
                onSelect(created.id);
              } catch (error) {
                onError(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>{translateUI("团队名称 ")}<input
                aria-label={translateUI("团队名称")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
              />
            </label>
            <label>{translateUI("简介 ")}<textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={1000}
              />
            </label>
            <div className="management-actions">
              <button disabled={busy} className="primary">{translateUI("创建团队 ")}</button>
              <button type="button" onClick={() => setCreating(false)}>{translateUI("取消 ")}</button>
            </div>
          </form>
        )}
        <div className={"team-grid team-directory " + (view === "list" ? "list-view" : "cards-view")} aria-label={translateUI("团队列表")}>
          {teams.map((t) => (
            <button
              className="team-card"
              key={t.id}
              onClick={() => onSelect(t.id)}
            >
              <span className="team-avatar"><Icon name="users" size={25} /></span>
              <span className="team-card-body">
              <strong>
                {t.name}
                {t.archived ? translateUI(" · 已归档") : ""}
              </strong>
              <p>{t.description || translateUI("团队知识与研究记录")}</p>
              <small>
                {t.member_count}{translateUI(" 位成员 · ")}{t.library_count}{translateUI(" 个知识库 ·")}{" "}
                {t.role === "admin" ? translateUI("团队管理员") : translateUI("成员")}
              </small>
              </span>
              <span className="team-enter">{translateUI("进入团队 →")}</span>
            </button>
          ))}
        </div>
        {!teams.length && !creating && (
          <p className="muted">{translateUI("创建团队，或通过邀请链接加入其他团队。")}</p>
        )}
      </div>
    );
  if (!team)
    return (
      <div className="academic-browser">
        <p>{translateUI("正在打开团队…")}</p>
      </div>
    );
  const admin = team.role === "admin";
  const notes = documents.filter(n => !n.archived && libraries.some(l => l.team_id === teamId && l.id === n.space_id));
  const pinnedIds = new Set([team.announcement_doc_id,...(team.pinned_note_ids || [])]);
  const pinned = notes.filter(n => pinnedIds.has(n.id));
  return (
    <div className="academic-browser team-hub">
      <header className="team-heading">
        <div>
          <h1>{team.name}</h1>
          {team.description && <p className="muted">{team.description}</p>}
        </div>
      </header>
      <nav className="management-tabs">
        {[
          ["home", translateUI("首页")],
          ["libraries", translateUI("知识库")],
          ["members", translateUI("成员")],
          ...(admin ? [["settings", translateUI("设置")]] : []),
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => { setTab(key); history.replaceState(null,"",`/?team=${teamId}${key === "home" ? "" : "&view="+key}`); }}
          >
            {label}
          </button>
        ))}
      </nav>
      {notice && (
        <p className="team-notice" role="status">
          {notice}
        </p>
      )}
      {team.archived && (
        <p className="team-notice">{translateUI("此团队已归档，知识库和外部分享暂不可访问。 ")}</p>
      )}
      {tab === "libraries" && !team.archived && <section className="team-libraries">
        <header className="library-collection-header">
          <h2>{team.name}{translateUI("知识库")}</h2>
          <div className="academic-page-actions">
            <div className="library-view-toolbar">{libraryViewControls}</div>
            {(admin || team.members_can_create_libraries) && <button className="primary" onClick={onNewLibrary}><Icon name="plus"/>{translateUI("新建知识库")}</button>}
          </div>
        </header>
        {librariesContent}
      </section>}
      {tab === "home" && !team.archived && <>
        <h3>{translateUI("置顶笔记")}</h3>
        <div className="team-recent team-pinned">
          {pinned.map(note => <button key={note.id} onClick={() => onOpenNote(note.id)}><span><Icon name="pin" size={16} /> {note.title}</span><small>{note.space_name}</small></button>)}
          {!pinned.length && <p className="muted">{translateUI("管理员可在设置中选择欢迎词、教程等置顶笔记。")}</p>}
        </div>
        <h3>{translateUI("最近更新")}</h3>
        <div className="team-recent">{notes.slice(0,10).map(note => <button key={note.id} onClick={() => onOpenNote(note.id)}><span>{note.title}</span><small>{new Date(note.updated_at).toLocaleDateString(uiLocale())}</small></button>)}</div>
        {!notes.length && <p className="muted">{translateUI("暂无可访问的笔记")}</p>}
      </>}
      {tab === "members" && (
        <>
          <p className="muted">
            {team.members.length}{translateUI(" 位成员。团队角色与平台角色分别管理。 ")}</p>
          {admin && !team.archived && (
            <form
              className="invite-member-inline"
              onSubmit={async (e) => {
                e.preventDefault();
                if (inviting) return;
                setInviting(true);
                try {
                  const result = await api(`teams/${teamId}/invites`, "POST", {
                    email,
                  });
                  const config = await api("platform/public");
                  setInvite((config.public_origin || serverURL) + result.path);
                  setInviteReusable(result.reusable);
                  setEmail("");
                  await refresh();
                } catch (error) {
                  onError(error);
                } finally {
                  setInviting(false);
                }
              }}
            >
              <strong>{translateUI("邀请成员")}</strong>
              <label>
                <input
                  aria-label={translateUI("邀请邮箱")}
                  placeholder={translateUI("指定邮箱（可选）")}
                  title={translateUI("填写后仅该已验证邮箱可接受邀请")}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <button className="primary" disabled={inviting} aria-label={translateUI("生成邀请链接")}>{inviting ? translateUI("正在生成…") : translateUI("生成邀请链接")}</button>
              {invite && (
                <div className="invite-link-result">
                  <input
                    ref={inviteInput}
                    aria-label={translateUI("团队邀请链接")}
                    title={inviteReusable ? translateUI("7 天内有效，不限加入人数；可在邀请记录中撤销") : translateUI("7 天内有效，仅指定的已验证邮箱可接受，接受后失效")}
                    readOnly
                    value={invite}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    disabled={copyState === "copying"}
                    aria-live="polite"
                    onClick={() => void copyInvite()}
                  >
                    {copyState === "copied" ? translateUI("已复制") : copyState === "copying" ? translateUI("正在复制…") : translateUI("复制邀请链接")}
                  </button>
                  {copyState === "error" && <small className="invite-copy-error" role="alert">{translateUI("复制失败，请选中链接手动复制")}</small>}
                </div>
              )}
            </form>
          )}
          <div className="team-member-list">
            {team.members.map((member: any) => (
              <div className="team-member-row" key={member.id}>
                <span className="user-avatar">{member.name.slice(0, 1)}</span>
                <span>
                  <strong>
                    {member.name}
                    {member.id === user.id ? translateUI("（我）") : ""}
                  </strong>
                  <small>{member.email || member.username}</small>
                </span>
                {admin ? (
                  <select
                    aria-label={translateUI("团队角色 {0}", [member.username])}
                    value={member.role}
                    onChange={async (e) => {
                      try {
                        await api(`teams/${teamId}/members`, "POST", {
                          user_id: member.id,
                          role: e.target.value,
                        });
                        await refresh();
                        await onChanged();
                      } catch (error) {
                        onError(error);
                      }
                    }}
                  >
                    <option value="admin">{translateUI("团队管理员")}</option>
                    <option value="member">{translateUI("团队成员")}</option>
                  </select>
                ) : (
                  <small>
                    {member.role === "admin" ? translateUI("团队管理员") : translateUI("团队成员")}
                  </small>
                )}
                {(admin || member.id === user.id) && (
                  <button
                    onClick={async () => {
                      try {
                        await api(`teams/${teamId}/members`, "POST", {
                          user_id: member.id,
                          role: null,
                        });
                        if (member.id === user.id) onSelect("");
                        else await refresh();
                        await onChanged();
                      } catch (error) {
                        onError(error);
                      }
                    }}
                  >
                    {member.id === user.id ? translateUI("退出团队") : translateUI("移出团队")}
                  </button>
                )}
              </div>
            ))}
          </div>
          {admin && team.invites.length > 0 && (
            <details className="team-details">
              <summary>{translateUI("邀请记录")}</summary>
              {team.invites.map((item: any) => (
                <div className="team-invite-row" key={item.id}>
                  <span>
                    {item.email || translateUI("未限制邮箱")} ·{" "}
                    {item.revoked_at
                      ? translateUI("已撤销")
                      : !item.reusable && item.accepted_by
                        ? translateUI("已接受")
                        : new Date(item.expires_at).getTime() < Date.now()
                          ? translateUI("已过期")
                          : item.reusable ? translateUI("有效 · 不限人数 · 已加入 {0} 人", [item.acceptance_count]) : translateUI("待接受")}
                  </span>
                  {!item.revoked_at && (item.reusable || !item.accepted_by) && new Date(item.expires_at).getTime() > Date.now() && (
                    <button
                      onClick={async () => {
                        try {
                          await api(
                            `teams/${teamId}/invites/${item.id}`,
                            "DELETE",
                          );
                          await refresh();
                        } catch (error) {
                          onError(error);
                        }
                      }}
                    >{translateUI("撤销邀请 ")}</button>
                  )}
                </div>
              ))}
            </details>
          )}
        </>
      )}
      {tab === "settings" && admin && (
        <form
          className="management-form"
          onSubmit={(e) => {
            e.preventDefault();
            void update({
              name: team.name,
              description: team.description,
              allow_external_sharing: team.allow_external_sharing,
              members_can_create_libraries: team.members_can_create_libraries,
              announcement_doc_id: team.announcement_doc_id,
              pinned_note_ids: team.pinned_note_ids || [],
            });
          }}
        >
          <h3>{translateUI("团队资料")}</h3>
          <label>{translateUI("团队名称 ")}<input
              aria-label={translateUI("编辑团队名称")}
              value={team.name}
              onChange={(e) => setTeam({ ...team, name: e.target.value })}
              maxLength={80}
              required
            />
          </label>
          <label>{translateUI("团队介绍 ")}<textarea
              value={team.description}
              onChange={(e) =>
                setTeam({ ...team, description: e.target.value })
              }
              maxLength={1000}
            />
          </label>
          <label>{translateUI("首页公告笔记 ")}<select
              aria-label={translateUI("首页公告笔记")}
              value={team.announcement_doc_id || ""}
              onChange={(e) =>
                setTeam({
                  ...team,
                  announcement_doc_id: e.target.value || null,
                })
              }
            >
              <option value="">{translateUI("不设置公告")}</option>
              {notes
                .filter(
                  (note) =>
                    note.visibility === "team" &&
                    !note.archived &&
                    team.libraries.some(
                      (l: any) =>
                        l.id === note.space_id && l.access_mode === "team",
                    ),
                )
                .map((note) => (
                  <option key={note.id} value={note.id}>
                    {note.title}
                  </option>
                ))}
            </select>
          </label>
          <fieldset className="team-pin-picker"><legend>{translateUI("首页置顶笔记（最多 20 篇）")}</legend><p className="muted">{translateUI("置顶不改变笔记的访问权限。")}</p>{notes.map(note => <label className="management-check" key={note.id}><input type="checkbox" checked={(team.pinned_note_ids || []).includes(note.id)} onChange={e => setTeam({...team,pinned_note_ids:e.target.checked ? [...(team.pinned_note_ids || []),note.id] : team.pinned_note_ids.filter((id: string) => id !== note.id)})} />{note.title}</label>)}</fieldset>
          <h3>{translateUI("安全与权限")}</h3>
          <label className="management-check">
            <input
              aria-label={translateUI("允许团队笔记对外分享")}
              type="checkbox"
              checked={team.allow_external_sharing}
              onChange={(e) =>
                setTeam({ ...team, allow_external_sharing: e.target.checked })
              }
            />{translateUI("允许团队笔记对外分享 ")}</label>
          <p className="muted">{translateUI("关闭后已有外链及其附件立即失效。团队内部仍按知识库的可见范围访问。 ")}</p>
          <label className="management-check">
            <input
              aria-label={translateUI("允许成员创建知识库")}
              type="checkbox"
              checked={team.members_can_create_libraries}
              onChange={(e) =>
                setTeam({
                  ...team,
                  members_can_create_libraries: e.target.checked,
                })
              }
            />{translateUI("允许普通成员创建团队知识库 ")}</label>
          <div className="management-actions">
            <button className="primary" disabled={busy}>{translateUI("保存团队设置 ")}</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void update({ archived: !team.archived })}
            >
              {team.archived ? translateUI("恢复团队") : translateUI("归档团队")}
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={busy}
              onClick={() => onDeleteTeam(team)}
            >{translateUI("删除团队 ")}</button>
          </div>
        </form>
      )}
    </div>
  );
}

export function TeamInvitation({
  onJoined,
  onError,
}: {
  onJoined: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const [token, setToken] = useState(
      () =>
        new URLSearchParams(location.search).get("invite") ||
        sessionStorage.getItem("pending_team_invite") ||
        "",
    ),
    [invite, setInvite] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const dialog = useDialog(close,{open:!!token,disabled:busy});
  useEffect(() => {
    if (token)
      void api("team-invitations/" + encodeURIComponent(token))
        .then(setInvite)
        .catch((e) => setError(translateUI(e.message)));
  }, [token]);
  if (!token) return null;
  function close() {
    sessionStorage.removeItem("pending_team_invite");
    const url = new URL(location.href);
    url.searchParams.delete("invite");
    history.replaceState(null, "", url);
    setToken("");
  }
  return (
    <div className="modal academic-modal">
      <section
        ref={dialog}
        className="academic-settings"
        role="dialog"
        aria-label={translateUI("加入团队")}
      >
        <header>
          <h2>{invite ? translateUI("加入 {0}", [invite.name]) : translateUI("团队邀请")}</h2>
          <DialogClose onClick={close} label={translateUI("关闭邀请")} disabled={busy}/>
        </header>
        <div className="settings-body">
          {error ? (
            <p role="alert">{error}</p>
          ) : invite ? (
            <>
              <p>{translateUI("邀请你加入此团队，一同整理知识库和研究笔记。")}</p>
              {invite.email && <p>{translateUI("指定已验证邮箱：")}{invite.email}</p>}
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await api(
                      `team-invitations/${token}/accept`,
                      "POST",
                    );
                    close();
                    onJoined(result.team_id);
                  } catch (e) {
                    setError(translateUI((e as Error).message));
                    onError(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >{translateUI("接受邀请 ")}</button>
            </>
          ) : (
            <p>{translateUI("正在读取邀请…")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

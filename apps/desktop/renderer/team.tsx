import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState } from "react";
import { request as api, type User } from "./native";
const roles = {
  admin: translateUI("知识库管理员"),
  editor: translateUI("可编辑"),
  reviewer: translateUI("可评论"),
  viewer: translateUI("可阅读"),
};
const statuses: Record<string, string> = {
  active: translateUI("已启用"),
  pending: translateUI("待批准"),
  disabled: translateUI("已停用"),
};

export function TeamManagement({
  user,
  onError,
}: {
  user: User;
  onError: (error: unknown) => void;
}) {
  const [data, setData] = useState<any>(null),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState<any>(null),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function refresh() {
    const next = await api("team");
    setData(next);
    return next;
  }
  useEffect(() => {
    void refresh().catch(onError);
  }, []);
  async function saveMember(input: any) {
    setBusy(true);
    setNotice("");
    try {
      await api("team/members/" + selected.id, "PATCH", input);
      if (selected.id === user.id && input.password) {
        setSelected(null);
        setNotice(translateUI("密码已修改，当前会话已结束。请退出登录，再使用新密码登录。"));
        return;
      }
      await refresh();
      setSelected(null);
      setNotice(translateUI("成员设置已保存。权限或密码变更后，成员需要重新登录。"));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <p>{translateUI("正在读取团队信息…")}</p>;
  const members = data.members.filter(
    (member: any) =>
      (filter === "all" || member.membership_status === filter) &&
      (member.name + " " + member.username)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="team-management">
      <div className="team-heading">
        <div>
          <h3>{data.name}</h3>
          <p className="muted">
            {data.members.length}{translateUI(" 位成员 ·")}{" "}
            {
              data.members.filter((m: any) => m.membership_status === "pending")
                .length
            }{" "}{translateUI("位待批准 ")}</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
        >{translateUI("添加成员 ")}</button>
      </div>
      <details className="team-details">
        <summary>{translateUI("团队资料")}</summary>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await api("team", "PATCH", {
                name: data.name,
                description: data.description,
              });
              setNotice(translateUI("团队资料已保存"));
            } catch (error) {
              onError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>{translateUI("团队名称 ")}<input
              aria-label={translateUI("团队名称")}
              maxLength={80}
              required
              value={data.name}
              onChange={(e) => setData({ ...data, name: e.target.value })}
            />
          </label>
          <label>{translateUI("团队介绍 ")}<textarea
              maxLength={1000}
              value={data.description}
              onChange={(e) =>
                setData({ ...data, description: e.target.value })
              }
            />
          </label>
          <button disabled={busy}>{translateUI("保存团队资料")}</button>
        </form>
      </details>
      <p className="muted">{translateUI("新 Casdoor 成员需批准后才能登录。批准后，请为其分配团队知识库；个人笔记仍按各自的共享设置访问。 ")}</p>
      <div className="team-filters">
        <input
          aria-label={translateUI("搜索团队成员")}
          placeholder={translateUI("搜索姓名或用户名")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label={translateUI("成员状态筛选")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">{translateUI("全部状态")}</option>
          {Object.entries(statuses).map(([v, n]) => (
            <option key={v} value={v}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {notice && (
        <p role="status" className="team-notice">
          {notice}
        </p>
      )}
      <div className="team-member-list" hidden={!!selected || creating}>
        {members.map((member: any) => (
          <button
            className="team-member"
            key={member.id}
            onClick={() => {
              setSelected({
                ...member,
                password: "",
                libraries: [...member.libraries],
              });
              setCreating(false);
            }}
          >
            <span className="user-avatar">{member.name.slice(0, 1)}</span>
            <span>
              <strong>
                {member.name}
                {member.id === user.id ? translateUI("（我）") : ""}
              </strong>
              <small>{member.username}</small>
              <small>
                {member.is_admin ? translateUI("团队管理员 · ") : ""}
                {member.casdoor_linked ? "Casdoor" : translateUI("本地账号")} ·{" "}
                {member.libraries.length}{translateUI(" 个知识库 ")}</small>
            </span>
            <span className={"member-status " + member.membership_status}>
              {statuses[member.membership_status]}
            </span>
            <span>{translateUI("管理 ›")}</span>
          </button>
        ))}
        {!members.length && <p className="muted">{translateUI("没有符合条件的成员")}</p>}
      </div>
      {creating && (
        <form
          className="team-member-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            try {
              const created = await api(
                "users",
                "POST",
                Object.fromEntries(form),
              );
              const next = await refresh();
              setSelected({
                ...next.members.find((m: any) => m.id === created.id),
                password: "",
              });
              setCreating(false);
              setNotice(translateUI("账号已创建，请继续设置知识库权限。"));
            } catch (error) {
              onError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="team-heading">
            <h3>{translateUI("添加本地成员")}</h3>
            <button type="button" onClick={() => setCreating(false)}>{translateUI("取消 ")}</button>
          </div>
          <p className="muted">{translateUI("使用 Casdoor 的成员先通过统一登录申请加入，无需创建本地账号。 ")}</p>
          <label>{translateUI("姓名 ")}<input name="name" aria-label={translateUI("成员姓名")} required maxLength={80} />
          </label>
          <label>{translateUI("用户名 ")}<input
              name="username"
              aria-label={translateUI("成员用户名")}
              pattern="[A-Za-z0-9_.\-]{3,64}"
              required
              autoComplete="off"
            />
          </label>
          <label>{translateUI("初始密码 ")}<input
              name="password"
              aria-label={translateUI("成员初始密码")}
              type="password"
              minLength={12}
              maxLength={512}
              autoComplete="new-password"
              required
            />
          </label>
          <button className="primary" disabled={busy}>{translateUI("创建并分配权限 ")}</button>
        </form>
      )}
      {selected && (
        <form
          className="team-member-editor"
          key={selected.id}
          onSubmit={(event) => {
            event.preventDefault();
            const input: any = { name: selected.name };
            if (selected.id !== user.id) {
              input.status = selected.membership_status;
              input.is_admin = selected.is_admin;
              input.libraries = selected.libraries.map((l: any) => ({
                space_id: l.space_id,
                role: l.role,
              }));
            }
            if (selected.password) input.password = selected.password;
            void saveMember(input);
          }}
        >
          <div className="team-heading">
            <h3>{translateUI("管理 ")}{selected.name}</h3>
            <button type="button" onClick={() => setSelected(null)}>{translateUI("关闭 ")}</button>
          </div>
          <label>{translateUI("姓名 ")}<input
              aria-label={translateUI("编辑成员姓名")}
              required
              maxLength={80}
              value={selected.name}
              onChange={(e) =>
                setSelected({ ...selected, name: e.target.value })
              }
            />
          </label>
          <label>{translateUI("账号状态 ")}<select
              aria-label={translateUI("账号状态")}
              disabled={selected.id === user.id}
              value={selected.membership_status}
              onChange={(e) =>
                setSelected({ ...selected, membership_status: e.target.value })
              }
            >
              {Object.entries(statuses).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="team-checkbox">
            <input
              type="checkbox"
              checked={selected.is_admin}
              disabled={selected.id === user.id}
              onChange={(e) =>
                setSelected({ ...selected, is_admin: e.target.checked })
              }
            />{translateUI("团队管理员（可管理团队及全部团队知识库） ")}</label>
          <fieldset disabled={selected.id === user.id}>
            <legend>{translateUI("团队知识库权限")}</legend>
            {data.libraries.map((library: any) => {
              const entry = selected.libraries.find(
                (l: any) => l.space_id === library.id,
              );
              return (
                <label className="team-library-role" key={library.id}>
                  <span>{library.name}</span>
                  <select
                    aria-label={translateUI("知识库权限 {0}", [library.name])}
                    value={entry?.role || ""}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        libraries: [
                          ...selected.libraries.filter(
                            (l: any) => l.space_id !== library.id,
                          ),
                          ...(e.target.value
                            ? [{ space_id: library.id, role: e.target.value }]
                            : []),
                        ],
                      })
                    }
                  >
                    <option value="">{translateUI("无权限")}</option>
                    {Object.entries(roles).map(([v, n]) => (
                      <option key={v} value={v}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            {!data.libraries.length && (
              <p className="muted">{translateUI("请先从侧边栏创建团队知识库。")}</p>
            )}
          </fieldset>
          {selected.local_password_enabled ? (
            <label>{translateUI("重置密码（留空则保留） ")}<input
                aria-label={translateUI("重置成员密码")}
                type="password"
                minLength={12}
                maxLength={512}
                value={selected.password}
                onChange={(e) =>
                  setSelected({ ...selected, password: e.target.value })
                }
                autoComplete="new-password"
              />
            </label>
          ) : (
            <p className="muted">{translateUI("此账号使用 Casdoor 登录，密码由 Casdoor 管理。 ")}</p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? translateUI("保存中…") : translateUI("保存成员设置")}
          </button>
        </form>
      )}
    </section>
  );
}

export function AccountIdentity({
  native,
  serverURL,
  onError,
}: {
  native: boolean;
  serverURL: string;
  onError: (error: unknown) => void;
}) {
  const [info, setInfo] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    void api("auth/identities")
      .then(setInfo)
      .catch(() => {});
  }, []);
  if (!info?.enabled) return null;
  return (
    <div className="account-identity">
      <h3>{translateUI("统一身份登录")}</h3>
      <p>
        {info.casdoor_linked
          ? translateUI("此账号已绑定 Casdoor。")
          : translateUI("绑定后，可使用 Casdoor 登录此账号，继续访问已有笔记。")}
      </p>
      {!info.casdoor_linked && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (native) {
                await window.anote.connectCasdoor({
                  serverURL,
                  intent: "link",
                });
                setInfo({ ...info, casdoor_linked: true });
                setNotice(translateUI("Casdoor 已绑定"));
              } else {
                const result = await api("auth/casdoor/link", "POST");
                location.assign(result.url);
              }
            } catch (error) {
              onError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? translateUI("请在浏览器中完成绑定…") : translateUI("绑定 Casdoor")}
        </button>
      )}
      {native && busy && (
        <button onClick={() => void window.anote.cancelCasdoor()}>{translateUI("取消绑定 ")}</button>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

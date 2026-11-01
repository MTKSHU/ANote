import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState } from "react";
import { request as api, type User } from "./native";
export function PlatformUsers({
  user,
  onError,
}: {
  user: User;
  onError: (e: unknown) => void;
}) {
  const [users, setUsers] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [query, setQuery] = useState(""),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function refresh() {
    setUsers((await api("team")).members);
  }
  useEffect(() => {
    void refresh().catch(onError);
  }, []);
  return (
    <section>
      <div className="team-heading">
        <div>
          <h3>{translateUI("平台用户")}</h3>
          <p className="muted">
            {users.length}{translateUI(" 位用户 · 团队角色在各团队中分别管理 ")}</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
        >{translateUI("添加本地用户 ")}</button>
      </div>
      {notice && (
        <p className="team-notice" role="status">
          {notice}
        </p>
      )}
      {!creating && !selected && (
        <>
          <input
            className="user-search"
            aria-label={translateUI("搜索用户")}
            placeholder={translateUI("搜索姓名、用户名或邮箱")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="team-member-list">
            {users
              .filter((person) =>
                (
                  person.name +
                  " " +
                  person.username +
                  " " +
                  (person.email || "")
                )
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((person) => (
                <button
                  key={person.id}
                  className="team-member"
                  onClick={() => setSelected({ ...person, password: "" })}
                >
                  <span className="user-avatar">{person.name.slice(0, 1)}</span>
                  <span>
                    <strong>
                      {person.name}
                      {person.id === user.id ? translateUI("（我）") : ""}
                    </strong>
                    <small>{person.email || person.username}</small>
                    <small>
                      {person.is_admin ? translateUI("平台管理员") : translateUI("用户")} ·{" "}
                      {person.local_password_enabled ? translateUI("本地账号") : translateUI("OIDC 账号")}
                      {person.casdoor_linked ? translateUI(" · 已绑定 OIDC") : ""}
                    </small>
                  </span>
                  <span className={"member-status " + person.membership_status}>
                    {person.active
                      ? translateUI("已启用")
                      : person.membership_status === "pending"
                        ? translateUI("待批准")
                        : translateUI("已停用")}
                  </span>
                  <span>{translateUI("管理 ›")}</span>
                </button>
              ))}
          </div>
        </>
      )}
      {creating && (
        <form
          className="management-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            try {
              await api("users", "POST", Object.fromEntries(form));
              setCreating(false);
              await refresh();
              setNotice(translateUI("用户已创建，可以通过团队邀请加入团队。"));
            } catch (error) {
              onError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>{translateUI("姓名 ")}<input
              aria-label={translateUI("新用户姓名")}
              name="name"
              required
              maxLength={80}
            />
          </label>
          <label>{translateUI("用户名 ")}<input
              aria-label={translateUI("新用户用户名")}
              name="username"
              pattern="[A-Za-z0-9_.\-]{3,64}"
              required
            />
          </label>
          <label>{translateUI("初始密码 ")}<input
              aria-label={translateUI("新用户密码")}
              name="password"
              type="password"
              minLength={12}
              maxLength={512}
              autoComplete="new-password"
              required
            />
          </label>
          <div className="management-actions">
            <button className="primary" disabled={busy}>{translateUI("创建用户 ")}</button>
            <button type="button" onClick={() => setCreating(false)}>{translateUI("取消 ")}</button>
          </div>
        </form>
      )}
      {selected && (
        <form
          className="management-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("team/members/" + selected.id, "PATCH", {
                name: selected.name,
                email: selected.email || null,
                email_verified: !!selected.email_verified,
                ...(selected.id !== user.id
                  ? {
                      status: selected.membership_status,
                      is_admin: selected.is_admin,
                    }
                  : {}),
                ...(selected.password ? { password: selected.password } : {}),
              });
              if (selected.id !== user.id || !selected.password)
                await refresh();
              setSelected(null);
              setNotice(translateUI("用户设置已保存；账号停用或密码变化会撤销现有会话。"));
            } catch (error) {
              onError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>{translateUI("管理 ")}{selected.name}</h3>
          <label>{translateUI("姓名 ")}<input
              aria-label={translateUI("编辑用户姓名")}
              value={selected.name}
              onChange={(e) =>
                setSelected({ ...selected, name: e.target.value })
              }
              required
              maxLength={80}
            />
          </label>
          <label>{translateUI("邮箱 ")}<input
              aria-label={translateUI("用户邮箱")}
              type="email"
              value={selected.email || ""}
              onChange={(e) =>
                setSelected({
                  ...selected,
                  email: e.target.value,
                  email_verified: false,
                })
              }
            />
          </label>
          <label className="management-check">
            <input
              aria-label={translateUI("邮箱归属已核实")}
              type="checkbox"
              checked={!!selected.email_verified}
              onChange={(e) =>
                setSelected({ ...selected, email_verified: e.target.checked })
              }
            />{translateUI("管理员已核实该邮箱归属 ")}</label>
          <p className="muted">{translateUI("已验证邮箱用于 OIDC 首次登录时自动关联此账号。 ")}</p>
          <label>{translateUI("账号状态 ")}<select
              aria-label={translateUI("用户状态")}
              disabled={selected.id === user.id}
              value={selected.membership_status}
              onChange={(e) =>
                setSelected({ ...selected, membership_status: e.target.value })
              }
            >
              <option value="active">{translateUI("启用")}</option>
              <option value="disabled">{translateUI("停用")}</option>
              <option value="pending">{translateUI("待批准")}</option>
            </select>
          </label>
          <label className="management-check">
            <input
              aria-label={translateUI("平台管理员")}
              type="checkbox"
              checked={selected.is_admin}
              disabled={selected.id === user.id}
              onChange={(e) =>
                setSelected({ ...selected, is_admin: e.target.checked })
              }
            />{translateUI("平台管理员 ")}</label>
          {selected.local_password_enabled ? (
            <label>{translateUI("重置本地密码（留空保留） ")}<input
                aria-label={translateUI("重置本地密码")}
                type="password"
                value={selected.password}
                onChange={(e) =>
                  setSelected({ ...selected, password: e.target.value })
                }
                minLength={12}
                maxLength={512}
                autoComplete="new-password"
              />
            </label>
          ) : (
            <p className="muted">{translateUI("OIDC 用户的密码由身份认证服务管理。")}</p>
          )}
          <div className="management-actions">
            <button className="primary" disabled={busy}>{translateUI("保存用户设置 ")}</button>
            {selected.id !== user.id && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  try {
                    await api(`users/${selected.id}/revoke-sessions`, "POST");
                    setNotice(translateUI("已撤销该用户的全部登录会话，用户需重新登录。"));
                  } catch (error) {
                    onError(error);
                  }
                }}
              >{translateUI("撤销全部会话 ")}</button>
            )}
            <button type="button" onClick={() => setSelected(null)}>{translateUI("取消 ")}</button>
          </div>
        </form>
      )}
    </section>
  );
}

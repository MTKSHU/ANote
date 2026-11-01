import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useState } from "react";
import { request as api, type User } from "./native";
import { PlatformUsers } from "./platform-users";
export function PlatformAdmin({
  user,
  onError,
}: {
  user: User;
  onError: (e: unknown) => void;
}) {
  const [tab, setTab] = useState("settings"),
    [config, setConfig] = useState<any>(null),
    [secret, setSecret] = useState(""),
    [origins, setOrigins] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [audit, setAudit] = useState<any[]>([]);
  useEffect(() => {
    void api("admin/settings")
      .then((value) => {
        setConfig(value);
        setOrigins(value.allowed_origins.join("\n"));
      })
      .catch(onError);
  }, []);
  useEffect(() => {
    if (tab === "audit") void api("admin/audit").then(setAudit).catch(onError);
  }, [tab]);
  return (
    <section className="platform-admin">
      <nav className="management-tabs">
        {[
          ["settings", translateUI("平台设置")],
          ["users", translateUI("用户管理")],
          ["audit", translateUI("操作记录")],
        ].map(([key, label]) => (
          <button
            className={tab === key ? "active" : ""}
            key={key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "users" ? (
        <PlatformUsers user={user} onError={onError} />
      ) : tab === "audit" ? (
        <div className="audit-list">
          {audit.map((item) => (
            <article key={item.id}>
              <strong>
                {item.actor_name || translateUI("系统")} · {item.action}
              </strong>
              <small>
                {new Date(item.created_at).toLocaleString(uiLocale())} · {item.target}
              </small>
            </article>
          ))}
        </div>
      ) : (
        config && (
          <form
            className="management-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setNotice("");
              try {
                const saved = await api("admin/settings", "PATCH", {
                  ...config,
                  allowed_origins: origins
                    .split(/\r?\n/)
                    .map((v) => v.trim())
                    .filter(Boolean),
                  ...(secret ? { oidc_secret: secret } : {}),
                });
                setConfig(saved);
                setSecret("");
                setOrigins(saved.allowed_origins.join("\n"));
                setNotice(translateUI("平台设置已保存并生效"));
                window.dispatchEvent(new Event("anote-settings-changed"));
              } catch (error) {
                onError(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h3>{translateUI("平台与域名")}</h3>
            <label>{translateUI("平台名称 ")}<input
                aria-label={translateUI("平台名称")}
                value={config.site_name}
                onChange={(e) =>
                  setConfig({ ...config, site_name: e.target.value })
                }
                required
                maxLength={80}
              />
            </label>
            <label>{translateUI("公共访问地址 ")}<input
                aria-label={translateUI("公共访问地址")}
                type="url"
                value={config.public_origin}
                onChange={(e) =>
                  setConfig({ ...config, public_origin: e.target.value })
                }
                placeholder="https://notes.example.org"
                required
              />
            </label>
            <p className="muted">{translateUI("共享链接、邀请链接和 OIDC 回调使用此地址。域名变更时同步配置 DNS、HTTPS 证书与反向代理；原域名会暂时加入允许来源。 ")}</p>
            <label>{translateUI("允许的内网／旧域名来源（每行一个） ")}<textarea
                aria-label={translateUI("允许来源")}
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
                rows={3}
                placeholder="http://192.168.1.10:3100"
              />
            </label>
            <h3>{translateUI("认证方式")}</h3>
            <label>{translateUI("登录方式 ")}<select
                aria-label={translateUI("登录方式")}
                value={config.auth_mode}
                onChange={(e) =>
                  setConfig({ ...config, auth_mode: e.target.value })
                }
              >
                <option value="local">{translateUI("仅平台账号")}</option>
                <option value="oidc">{translateUI("仅 OIDC 统一认证")}</option>
                <option value="both">{translateUI("平台账号与 OIDC 并存")}</option>
              </select>
            </label>
            <p className="muted">{translateUI("当前配置来源：数据库。OIDC")}{" "}
              {config.oidc_enabled ? translateUI("已启用") : translateUI("尚未启用")}。
              {config.missing_oidc_fields.length > 0
                ? translateUI("缺少：{0}", [config.missing_oidc_fields.join("、")])
                : ""}
            </p>
            <label>{translateUI("OIDC 服务地址 ")}<input
                aria-label={translateUI("OIDC 服务地址")}
                type="url"
                value={config.oidc_issuer}
                onChange={(e) =>
                  setConfig({ ...config, oidc_issuer: e.target.value })
                }
              />
            </label>
            <label>
              Client ID
              <input
                aria-label="OIDC Client ID"
                autoComplete="off"
                value={config.oidc_client_id}
                onChange={(e) =>
                  setConfig({ ...config, oidc_client_id: e.target.value })
                }
              />
            </label>
            <label>
              Client Secret
              <input
                aria-label="OIDC Client Secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={
                  config.oidc_secret_configured
                    ? translateUI("已设置；留空保留原密钥")
                    : translateUI("尚未设置")
                }
              />
            </label>
            <label>{translateUI("Casdoor 应用名（使用应用独立证书时填写） ")}<input
                aria-label={translateUI("OIDC 应用名")}
                value={config.oidc_application}
                onChange={(e) =>
                  setConfig({ ...config, oidc_application: e.target.value })
                }
              />
            </label>
            <p className="muted">{translateUI("回调地址：")}{config.public_origin}/api/auth/casdoor/callback
            </p>
            <p className="muted">{translateUI("首次登录按已验证邮箱关联已有账号，保留原笔记。OIDC 来源账号的密码由认证服务管理。仅 OIDC 模式需要当前管理员先完成身份绑定。 ")}</p>
            <div className="management-actions">
              <button className="primary" disabled={busy}>
                {busy ? translateUI("保存中…") : translateUI("保存平台设置")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  try {
                    const result = await api("admin/oidc/check", "POST");
                    setNotice(
                      translateUI("{0} 使用地址：{1}。{2}", [(result.credentials_configured
                        ? translateUI("OIDC discovery 连通，凭据已配置；请继续完成真实登录验证。")
                        : translateUI("OIDC discovery 连通；仍需配置 Client ID 和密钥。")), result.discovery_url, (result.warnings || []).join(" ")]),
                    );
                  } catch (error) {
                    onError(error);
                  }
                }}
              >{translateUI("检查已保存的 OIDC 配置 ")}</button>
            </div>
            {notice && <p role="status">{notice}</p>}
          </form>
        )
      )}
    </section>
  );
}

export function NicknameSettings({ user, disabled, onSaved }: {
  user: User;
  disabled: boolean;
  onSaved: (user: User) => void;
}) {
  const [name, setName] = useState(user.name),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  useEffect(() => { setName(user.name); }, [user.id, user.name]);
  return (
    <section className="account-identity">
      <h3>{translateUI("昵称")}</h3>
      <form className="management-form nickname-form" onSubmit={async event => {
        event.preventDefault();
        setSaving(true); setNotice(""); setError("");
        try {
          const updated = await api("me/profile", "PATCH", { name: name.trim() });
          onSaved(updated);
          setNotice(translateUI("昵称已保存"));
        } catch (failure: any) {
          setError(translateUI(failure.message || translateUI("昵称保存失败，请重试")));
        } finally { setSaving(false); }
      }}>
        <label>{translateUI("昵称 ")}<input autoComplete="nickname" maxLength={80} required value={name}
            disabled={disabled || saving} onChange={event => {
              setName(event.target.value); setNotice(""); setError("");
            }} />
        </label>
        <button disabled={disabled || saving || !name.trim() || name.trim() === user.name}>
          {saving ? translateUI("保存中…") : translateUI("保存昵称")}
        </button>
      </form>
      <p className="muted">{translateUI("昵称用于平台内显示，不影响登录账号。支持 1–80 个字符。")}</p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function ProfileSettings({
  user,
  onError,
  onLogout,
}: {
  user: User;
  onError: (e: unknown) => void;
  onLogout: () => void | Promise<void>;
}) {
  const [password, setPassword] = useState(""),
    [old, setOld] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="account-identity">
      <h3>{translateUI("账号信息")}</h3>
      <p>{translateUI("邮箱：")}{user.email || translateUI("尚未补充")}
        {user.email ? (user.email_verified ? translateUI("（已验证）") : translateUI("（未验证）")) : ""}
      </p>
      {user.local_password_enabled !== false ? (
        <details>
          <summary>{translateUI("修改本地密码")}</summary>
          <form
            className="management-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api("me", "PATCH", { old_password: old, password });
                await onLogout();
              } catch (error) {
                onError(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>{translateUI("当前密码 ")}<input
                aria-label={translateUI("当前密码")}
                type="password"
                autoComplete="current-password"
                value={old}
                onChange={(e) => setOld(e.target.value)}
                required
              />
            </label>
            <label>{translateUI("新密码 ")}<input
                aria-label={translateUI("新密码")}
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={512}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button disabled={busy}>{translateUI("修改后重新登录")}</button>
          </form>
        </details>
      ) : (
        <p className="muted">{translateUI("此账号使用 OIDC 身份服务，密码请在认证服务修改。 ")}</p>
      )}
    </section>
  );
}

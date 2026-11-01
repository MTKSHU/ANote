import React, { useState } from "react";
import { changeLanguage, getLocale, t, type Locale } from "@anote/i18n";

export function LanguageSelect() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <div className="language-settings">
    <label>{t("界面语言")}
      <select aria-label={t("界面语言")} value={getLocale()} disabled={busy} onChange={async event => {
        const next = event.target.value as Locale;
        setBusy(true);
        setError("");
        try {
          await changeLanguage(next);
          const url = new URL(location.href);
          url.searchParams.set("lang", next);
          location.assign(url.href);
        } catch {
          setError(t("无法保存当前笔记，语言尚未切换。请保存后重试。"));
          setBusy(false);
        }
      }}>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </label>
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}

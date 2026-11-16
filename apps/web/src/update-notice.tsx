import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import type { PlatformVersion } from "../../api/src/version-info";
import { saveBeforeReload } from "./update-reload";
import "./update-notice.css";

export type { PlatformVersion };

const dismissalKey = "anote:web-update-dismissed";
const entryPattern = /^\/assets\/index-[A-Za-z0-9_-]{6,64}\.js$/;
const checkEvent = "anote-check-web-update";
type CheckStatus = {kind:"checking"|"current"|"error";message?:string};

function loadedEntry() {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    try {
      const url = new URL(script.src, location.href);
      if (url.origin === location.origin && entryPattern.test(url.pathname))
        return url.pathname;
    } catch {}
  }
  return null;
}

export function WebUpdateNotice({
  onBeforeReload,
}: {
  onBeforeReload?: () => Promise<void>;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkStatus,setCheckStatus] = useState<CheckStatus|null>(null);
  const dismissed = useRef<string | null>(null);
  const reloading = useRef(false);

  useEffect(() => {
    const entry = loadedEntry();
    let active = true;
    let pending: {controller:AbortController;manual:boolean} | undefined;
    let feedbackTimer:number|undefined;
    try { dismissed.current = sessionStorage.getItem(dismissalKey); } catch {}

    function feedback(value:CheckStatus|null){
      window.clearTimeout(feedbackTimer);
      setCheckStatus(value);
      if(value?.kind==="current")feedbackTimer=window.setTimeout(()=>{if(active)setCheckStatus(null);},5_000);
    }
    async function check(manual=false) {
      if(reloading.current||(!manual&&document.hidden))return;
      if(manual){feedback({kind:"checking"});setError("");}
      // A menu click can join an automatic request already in flight.
      if(pending){if(manual)pending.manual=true;return;}
      if(!entry){if(manual)feedback({kind:"error",message:translateUI("无法读取当前页面版本，请稍后重试。")});return;}
      const controller = new AbortController();
      const request={controller,manual};
      pending = request;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch("/api/version", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok)throw new Error(translateUI("服务器暂时无法检查更新（HTTP {0}），请稍后重试。", [response.status]));
        let value:unknown;
        try{value=await response.json();}catch{throw new Error(translateUI("服务器未返回有效版本信息，请稍后重试。"));}
        if (!active) return;
        if(!value||typeof value!=="object"||!("web_entry" in value)||typeof value.web_entry!=="string"||!entryPattern.test(value.web_entry))throw new Error(translateUI("服务器版本信息暂不可用，请稍后重试。"));
        const next = value.web_entry;
        if(request.manual){
          if(next!==entry){
            dismissed.current=null;
            try{sessionStorage.removeItem(dismissalKey);}catch{}
            setVersion(next);feedback(null);
          }else{setVersion(null);feedback({kind:"current"});}
        }else{
          const available=next!==entry&&next!==dismissed.current;
          setVersion(available?next:null);
          if(available)feedback(null);
        }
      } catch(reason) {
        // Update checks are optional while the network is unavailable.
        if(active&&request.manual)feedback({kind:"error",message:controller.signal.aborted?translateUI("检查更新超时，请检查网络后重试。"):reason instanceof TypeError?translateUI("无法连接服务器，请检查网络后重试。"):reason instanceof Error?reason.message:translateUI("检查更新失败，请稍后重试。")});
      } finally {
        window.clearTimeout(timeout);
        if (pending === request) pending = undefined;
      }
    }
    const checkVisible = () => { if (!document.hidden) void check(); };
    const checkManual = () => {void check(true);};
    void check();
    const interval = window.setInterval(checkVisible, 5 * 60_000);
    window.addEventListener("focus", checkVisible);
    window.addEventListener("online", checkVisible);
    window.addEventListener(checkEvent,checkManual);
    document.addEventListener("visibilitychange", checkVisible);
    return () => {
      active = false;
      pending?.controller.abort();
      window.clearInterval(interval);
      window.clearTimeout(feedbackTimer);
      window.removeEventListener("focus", checkVisible);
      window.removeEventListener("online", checkVisible);
      window.removeEventListener(checkEvent,checkManual);
      document.removeEventListener("visibilitychange", checkVisible);
    };
  }, []);

  if (!version&&!checkStatus) return null;
  const checking=checkStatus?.kind==="checking";
  const checkFailed=checkStatus?.kind==="error";

  async function reload() {
    if (reloading.current) return;
    reloading.current = true;
    setBusy(true);
    setError("");
    try {
      await saveBeforeReload(onBeforeReload || (async () => {}), document);
      location.reload();
    } catch (reason) {
      setError(translateUI(reason instanceof Error && reason.message
        ? reason.message
        : translateUI("保存尚未完成，请检查连接后重试。")));
    } finally {
      reloading.current = false;
      setBusy(false);
    }
  }

  function later() {
    dismissed.current = version;
    try { sessionStorage.setItem(dismissalKey, version!); } catch {}
    setVersion(null);
    setError("");
    setCheckStatus(null);
  }

  return (
    <aside className="web-update-notice" role="status" aria-live="polite" aria-label={translateUI("平台更新提醒")} aria-busy={busy||checking}>
      <div className="web-update-copy">
        <strong>{version?translateUI("平台已更新"):checking?translateUI("正在检查更新"):checkFailed?translateUI("检查更新失败"):translateUI("当前已是最新版本")}</strong>
        {version&&<p>{translateUI("刷新后即可使用最新版本。")}</p>}
        {checking&&version&&<p>{translateUI("正在检查更新…")}</p>}
        {checkFailed&&<p className="web-update-error" role="alert">{checkStatus.message}</p>}
        {error && <p className="web-update-error" role="alert">{error}</p>}
      </div>
      <div className="web-update-actions">
        {version&&<button type="button" className="web-update-reload" disabled={busy||checking} onClick={() => void reload()}>
          {busy ? translateUI("正在保存…") : translateUI("保存并刷新")}
        </button>}
        {checkFailed&&<button type="button" onClick={()=>window.dispatchEvent(new Event(checkEvent))}>{translateUI("重试")}</button>}
        <button type="button" disabled={busy||checking} onClick={version?later:()=>setCheckStatus(null)}>{version?translateUI("稍后"):checking?translateUI("正在检查…"):translateUI("关闭")}</button>
      </div>
    </aside>
  );
}

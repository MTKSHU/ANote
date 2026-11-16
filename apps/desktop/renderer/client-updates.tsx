import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import type { ClientUpdateState } from "./native";
import { isUpdateRead, markUpdateRead, updateReadEvent } from "./client-update-notifications";
import "./client-updates.css";

type Props = { onConnectServer?: () => void; initialState?: ClientUpdateState };
export type ClientUpdateNotification = { id: string; version: string; read: boolean; state: ClientUpdateState; markRead: () => void };

function useUpdateState(initialState?: ClientUpdateState, enabled = true) {
  const [state, setState] = useState<ClientUpdateState | null>(initialState || null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (!enabled || !window.anote?.updateState) return;
    let live = true, notifications = 0;
    const remove = window.anote.onState(value => {
      if (live && value.updates) { notifications++; setState(value.updates); setLoadError(""); }
    });
    void window.anote.updateState().then(value => {
      if (live && !notifications) { setState(value); setLoadError(""); }
    }).catch(error => {
      if (live && !notifications) setLoadError(error instanceof Error ? error.message : translateUI("暂时无法读取更新状态"));
    });
    return () => { live = false; remove(); };
  }, [enabled]);
  return { state, setState:(value:ClientUpdateState)=>{setState(value);setLoadError("");}, loadError };
}

const busy = (state: ClientUpdateState) => ["checking", "downloading", "verifying", "preparing", "installing"].includes(state.status);
const labels: Record<ClientUpdateState["status"], string> = { idle: translateUI("尚未检查客户端更新"), checking: translateUI("正在检查更新…"), available: translateUI("发现新版本"), "up-to-date": translateUI("当前已是最新版本"), downloading: translateUI("正在下载更新…"), verifying: translateUI("正在校验更新…"), ready: translateUI("更新已下载并通过校验"), preparing: translateUI("正在准备更新…"), installing: translateUI("正在保存笔记并更新…"), error: translateUI("更新未完成") };

function hasNewVersion(state: ClientUpdateState | null) {
  if (!state?.latestVersion) return false;
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value.split(".").map(Number) : [];
  const next = parse(state.latestVersion), current = parse(state.currentVersion);
  if (next.length !== 3 || current.length !== 3 || [...next, ...current].some(value => !Number.isSafeInteger(value))) return false;
  for (let index = 0; index < 3; index++) if (next[index] !== current[index]) return next[index] > current[index];
  return false;
}

export function useClientUpdateNotification(initialState?: ClientUpdateState, enabled = true): ClientUpdateNotification | null {
  const { state } = useUpdateState(initialState, enabled), [, refresh] = useState(0);
  useEffect(() => {
    const changed = () => refresh(value => value + 1);
    window.addEventListener(updateReadEvent, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(updateReadEvent, changed); window.removeEventListener("storage", changed); };
  }, []);
  if (!enabled || !state || !hasNewVersion(state)) return null;
  const id = `${state.currentVersion}:${state.latestVersion}`;
  return { id, version: state.latestVersion!, state, read: isUpdateRead(id), markRead: () => markUpdateRead(id) };
}

function checkedAt(value?: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(uiLocale()) : translateUI("尚未检查");
}

export function connectForClientUpdate(callback?: () => void) {
  if (callback) callback();
  else window.dispatchEvent(new Event("anote-connect-server"));
}

function useUpdateAction(setState: (value: ClientUpdateState) => void, state:ClientUpdateState|null) {
  const [error, setError] = useState(""), [pending, setPending] = useState(false);
  const active = useRef(false);
  useEffect(()=>{if(state&&state.status!=="error")setError("");},[state?.status,state?.checkedAt]);
  async function run(operation: (() => Promise<unknown>) | undefined) {
    if (active.current) return;
    if (!operation) { setError(translateUI("当前客户端暂不支持此操作，请手动更新客户端")); return; }
    active.current = true; setPending(true); setError("");
    try {
      const value = await operation();
      if (value && typeof value === "object" && "currentVersion" in value) setState(value as ClientUpdateState);
    } catch (reason) { setError(translateUI(reason instanceof Error ? reason.message : translateUI("更新未完成，请重试"))); }
    finally { active.current = false; setPending(false); }
  }
  return { error, pending, run };
}

function primaryAction(state: ClientUpdateState) {
  if (state.status === "ready") return { label: translateUI("保存并重启更新"), operation: window.anote.installUpdate, disabled: !state.canInstall };
  if (state.needsAuth) return { label: translateUI("连接服务器后下载更新"), connect: true };
  if (!state.release) return { label: translateUI("重新检查更新"), operation: window.anote.checkUpdates };
  return { label: state.status === "error" ? translateUI("重试下载") : translateUI("下载更新"), operation: window.anote.downloadUpdate };
}

export function ClientUpdatePanel({ onConnectServer, initialState }: Props = {}) {
  const { state, setState, loadError } = useUpdateState(initialState), action = useUpdateAction(setState,state);
  if (!window.anote?.updateState) return null;
  const primary = state && hasNewVersion(state) ? primaryAction(state) : null;
  const disabled = action.pending || !!state && busy(state);
  return <section className="client-update-panel" aria-label={translateUI("客户端更新")} aria-busy={disabled}>
    <h2>{translateUI("客户端更新")}</h2>
    <p>{translateUI("当前版本 ")}<strong>{state?.currentVersion || translateUI("暂时无法读取")}</strong>{state?.latestVersion && <>{translateUI(" · 最新版本 ")}{state.latestVersion}</>}</p>
    <p role="status">{state ? labels[state.status] : loadError ? translateUI("更新状态读取失败") : translateUI("正在读取更新状态…")}{state?.status === "downloading" && ` ${Math.round(state.progress * 100)}%`}</p>
    <p className="client-update-checked">{translateUI("最近检查：")}{checkedAt(state?.checkedAt)}</p>
    {state?.status === "downloading" && <progress max={1} value={state.progress} aria-label={translateUI("客户端下载进度")}/>}
    {state?.needsAuth && hasNewVersion(state) && state.status !== "ready" && <p className="client-update-auth">{translateUI("已发现新版本。连接服务器后即可下载更新，当前笔记会保留。")}</p>}
    <div className="client-update-actions">
      <button type="button" disabled={disabled} onClick={() => void action.run(window.anote.checkUpdates)}>{translateUI("检查更新")}</button>
      {state && primary && <button type="button" className="primary" disabled={disabled || !!primary.disabled} onClick={() => primary.connect ? connectForClientUpdate(onConnectServer) : void action.run(primary.operation)}>{primary.label}</button>}
      {state?.downloadPath && <button type="button" disabled={action.pending} onClick={() => void action.run(window.anote.openUpdateFolder)}>{translateUI("打开下载目录")}</button>}
    </div>
    {state?.status === "ready" && !state.canInstall && <p className="muted">{translateUI("此客户端无法直接安装，请打开下载目录手动更新。")}</p>}
    <p className="muted">{translateUI("发现新版本不需要登录；下载需要连接服务器。安装前会保存笔记，保留个人笔记、本地副本和设置。")}</p>
    {(action.error || state?.error || loadError) && <p className="client-update-error" role="alert">{action.error || state?.error || loadError}</p>}
  </section>;
}

export function ClientUpdateBanner({ onConnectServer }: Pick<Props, "onConnectServer"> = {}) {
  const { state, setState } = useUpdateState(), action = useUpdateAction(setState,state);
  const [dismissed, setDismissed] = useState("");
  const key = state?.latestVersion || "";
  if (!state || !hasNewVersion(state) || dismissed === key || state.status === "up-to-date") return null;
  const installing = ["preparing", "installing"].includes(state.status), primary = primaryAction(state);
  return <aside className="client-update-banner" aria-label={translateUI("客户端版本更新")} aria-busy={action.pending || busy(state)}>
    <div><strong>ANote {state.latestVersion}{translateUI(" 已可更新")}</strong><p>{state.needsAuth && state.status !== "ready" ? translateUI("连接服务器后即可下载更新。") : labels[state.status]}{state.status === "downloading" && ` ${Math.round(state.progress * 100)}%`}</p>{(action.error || state.error) && <p role="alert">{action.error || state.error}</p>}</div>
    <button type="button" className="primary" disabled={action.pending || busy(state) || !!primary.disabled} onClick={() => primary.connect ? connectForClientUpdate(onConnectServer) : void action.run(primary.operation)}>{installing ? translateUI("正在更新…") : primary.label}</button>
    <button type="button" disabled={installing} onClick={() => setDismissed(key)}>{translateUI("稍后")}</button>
  </aside>;
}

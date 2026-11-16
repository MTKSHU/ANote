import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { request, type LocalBackup, type LocalBackupResult, type NativeState, type OfflineStorageState } from "./native";
import { DialogClose, useDialog } from "./dialog";
import "./offline-controls.css";

type Library = { id: string; name: string; team_name?: string | null; kind?: string };
type Backup = LocalBackup;
type StorageStatus = Omit<OfflineStorageState, "conflicts"> & {
  conflicts: (OfflineStorageState["conflicts"][number] & { baseTitle?: string; remoteTitle?: string })[];
};
type Config = OfflineStorageState["config"];
type Props = { state: NativeState; onError?: (error: unknown) => void };
const defaultConfig: Config = { enabled: false, scope: "all-readable", libraryIds: [], includeAssets: true, backupDirectory: "", retention: 10, backupIntervalMinutes: 15 };
const backupsPerPage = 10;

function libraries(value: unknown): Library[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, Library>();
  for (const item of value) {
    if (!item || typeof item.id !== "string" || typeof item.name !== "string") continue;
    result.set(item.id, { id: item.id, name: item.name, team_name: typeof item.team_name === "string" ? item.team_name : null, kind: item.kind });
  }
  return [...result.values()];
}

function configuration(status?: StorageStatus | null): Config {
  return { ...defaultConfig, ...status?.config, libraryIds: [...(status?.config.libraryIds || [])] };
}

function date(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return translateUI("尚无记录");
  return new Date(value).toLocaleString(uiLocale());
}

function backupSize(bytes: number) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const unit = bytes < 1024 ** 2 ? "KB" : bytes < 1024 ** 3 ? "MB" : "GB";
  const divisor = unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : 1024 ** 3;
  return `${(bytes / divisor).toLocaleString(uiLocale(), { maximumFractionDigits: 1 })} ${unit}`;
}

function backupNotice(result?: LocalBackupResult) {
  if (!result?.incremental) return translateUI("本地备份已完成");
  if (result.skipped) return translateUI("内容没有变化，已复用现有备份，未新增备份文件");
  const parts = [translateUI("增量备份已完成")];
  if (typeof result.addedBytes === "number") parts.push(translateUI("本次新增 {0}", [backupSize(result.addedBytes)]));
  if (typeof result.reusedBytes === "number" && result.reusedBytes > 0) parts.push(translateUI("已复用 {0}", [backupSize(result.reusedBytes)]));
  return parts.join(" · ");
}

export function OfflineControls(props: Props) {
  const identity = `${props.state.serverURL}\u0000${props.state.user?.id || ""}\u0000${!!props.state.personal}`;
  return <AccountOfflineControls key={identity} {...props} />;
}

function AccountOfflineControls({ state, onError }: Props) {
  const [status, setStatus] = useState<StorageStatus | null>((state.offlineStorage as StorageStatus) || null);
  const [draft, setDraft] = useState<Config>(() => configuration(state.offlineStorage));
  const [available, setAvailable] = useState<Library[]>(() => libraries((state.offlineStorage as StorageStatus)?.libraries));
  const [backups, setBackups] = useState<Backup[]>(() => (state.offlineStorage as StorageStatus)?.backups || []);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [target, setTarget] = useState<Backup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null), [backupPage, setBackupPage] = useState(1);
  const draftInitialized = useRef(!!state.offlineStorage), dirty = useRef(false), action = useRef(false), active = useRef(true);
  const confirm = useDialog(() => setTarget(null), { open: !!target, disabled: !!busy });
  const confirmDelete = useDialog(() => setDeleteTarget(null), { open: !!deleteTarget, disabled: !!busy });
  const bridge = typeof window !== "undefined" ? window.anote : undefined;
  const backupPages = Math.max(1, Math.ceil(backups.length / backupsPerPage));
  const currentBackupPage = Math.min(backupPage, backupPages);
  const displayedBackups = backups.slice((currentBackupPage - 1) * backupsPerPage, currentBackupPage * backupsPerPage);
  useEffect(() => setBackupPage(value => Math.min(value, backupPages)), [backupPages]);
  useEffect(() => setBackupPage(1), [status?.config.backupDirectory]);

  function receive(next?: StorageStatus) {
    if (!next || !active.current) return;
    setStatus(next);
    if (!draftInitialized.current) {
      if (!dirty.current) setDraft(configuration(next));
      draftInitialized.current = true;
    }
    const choices = libraries(next.libraries);
    if (Array.isArray(next.libraries)) setAvailable(choices);
    if (Array.isArray(next.backups)) setBackups(next.backups);
  }

  function report(reason: unknown) {
    if (!active.current) return;
    setError(translateUI(reason instanceof Error ? reason.message : translateUI("操作未完成，请重试")));
    onError?.(reason);
  }

  async function readBackups(directory: string) {
    if (!directory) { if (active.current) setBackups([]); return; }
    if (!bridge?.listBackups) throw new Error(translateUI("当前客户端不支持本地备份，请先更新客户端"));
    const result = await bridge.listBackups();
    if (active.current) setBackups(result);
  }

  async function refreshLibraries() {
    const result = libraries(await request("spaces"));
    if (active.current) setAvailable(result);
    return result;
  }

  useEffect(() => {
    active.current = true;
    if (state.personal || !bridge?.offlineStatus) { setLoading(false); return; }
    const stop = bridge.onState?.(next => {
      if (next.serverURL === state.serverURL && next.user?.id === state.user?.id && !next.personal)
        receive(next.offlineStorage as StorageStatus | undefined);
    });
    void (async () => {
      try {
        const next = await bridge.offlineStatus!() as StorageStatus;
        if (!active.current) return;
        receive(next);
        await Promise.allSettled([
          readBackups(next.config.backupDirectory),
          next.config.scope === "selected" && next.networkOnline !== false && !libraries(next.libraries).length ? refreshLibraries() : Promise.resolve(),
        ]).then(results => {
          if (active.current) {
            const failed = results.find(result => result.status === "rejected");
            if (failed?.status === "rejected") report(failed.reason);
          }
        });
      } catch (reason) { report(reason); }
      finally { if (active.current) setLoading(false); }
    })();
    return () => { active.current = false; stop?.(); };
  }, []);

  useEffect(() => {
    if (!state.personal) receive(state.offlineStorage as StorageStatus | undefined);
  }, [state.offlineStorage]);

  function change(patch: Partial<Config>) {
    dirty.current = true;
    setDraft(value => ({ ...value, ...patch }));
    setNotice("");
  }

  async function run(label: string, operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true;
    setBusy(label); setError(""); setNotice("");
    try { await operation(); }
    catch (reason) { report(reason); }
    finally { action.current = false; if (active.current) setBusy(""); }
  }

  async function save(patch: Partial<Config> = {}) {
    if (!bridge?.configureOffline) throw new Error(translateUI("当前客户端不支持离线副本，请先更新客户端"));
    const config = { ...draft, ...patch };
    if (config.enabled && config.scope === "selected" && !config.libraryIds.length)
      throw new Error(translateUI("请先选择需要保留本地副本的知识库，或改为全部可读取的内容"));
    const next = await bridge.configureOffline(config) as StorageStatus;
    receive(next);
    if (active.current) { setDraft(configuration(next)); dirty.current = false; }
    return next;
  }

  if (state.personal) return <section className="offline-controls" aria-label={translateUI("离线与备份设置")}><h3>{translateUI("平台笔记的离线副本与备份")}</h3><p>{translateUI("此配置用于连接平台的笔记。独立离线个人目录已有本地保存；返回平台后，可选择需要下载和备份的知识库。")}</p></section>;
  if (!bridge?.offlineStatus) return <section className="offline-controls" aria-label={translateUI("离线与备份设置")}><h3>{translateUI("离线与备份")}</h3><p>{translateUI("请使用支持此功能的桌面客户端配置本地副本与备份。")}</p></section>;

  const offline = state.offline || status?.networkOnline === false || status?.automaticOffline;
  const enabled = status?.enabled ?? status?.config.enabled ?? false;
  const progress = status?.progress;
  const unknownSelections = draft.libraryIds.filter(id => !available.some(item => item.id === id));
  const configuredDirectory = status?.config.backupDirectory || "";
  const options = [...new Set([7, 10, 30, 60, draft.retention])].sort((a, b) => a - b);
  const interval = draft.backupIntervalMinutes ?? 15;
  const intervals = [...new Set([0, 15, 60, 1440, interval])].sort((a, b) => a - b);
  const backupBlocked = !!busy || loading || !!status?.running || !!state.backupBusy || !!state.backupRestoring || !!state.storageMigrating || !!state.workspaceSwitching || ["preparing", "installing"].includes(state.updates?.status || "");

  return <section className="offline-controls" aria-label={translateUI("离线与备份设置")} aria-busy={!!busy || loading}>
    <header><h3>{translateUI("本地副本")}</h3><p>{translateUI("开启后自动在这台电脑保留服务器笔记，断网时继续查看和编辑已有内容，重新联网后自动保存修改。")}</p></header>
    {loading && <p role="status">{translateUI("正在读取本地副本…")}</p>}
    <label className="offline-resident-switch"><input type="checkbox" role="switch" aria-label={translateUI("始终保留服务器笔记的本地副本")} checked={draft.enabled} disabled={!!busy || loading} onChange={event => {
      if (action.current) return;
      const value = event.target.checked;
      const previous = draft.enabled, previousDirty = dirty.current;
      dirty.current = true;
      setDraft(current => ({ ...current, enabled: value }));
      void run(value ? translateUI("正在开启本地副本…") : translateUI("正在关闭自动下载…"), async () => {
        try {
          await save({ enabled: value });
          setNotice(value ? offline ? translateUI("已开启，联网后会自动补全本地副本") : translateUI("已开启，正在后台保存可读取的服务器笔记") : translateUI("已停止自动下载；已有本地内容和未上传修改会保留"));
        } catch (reason) {
          if (active.current) {
            setDraft(current => ({ ...current, enabled: previous }));
            dirty.current = previousDirty;
          }
          throw reason;
        }
      });
    }}/><span><strong>{translateUI("始终保留服务器笔记的本地副本")}</strong><small>{translateUI("默认包含当前账号可读取的全部知识库、目录、笔记及附件。此开关立即生效。")}</small></span></label>
    {offline && (enabled || !!status?.availableDocuments) && <p className="offline-controls-hint">{translateUI("暂时无法连接服务器，已自动使用本机已有内容；尚未下载的内容需联网后才能访问。本地备份和恢复仍可使用。")}</p>}
    {error && <p className="offline-controls-error" role="alert">{error}</p>}
    {(enabled || !!status?.pending) && status?.lastError && status.lastError !== error && <p className="offline-controls-error" role="alert">{status.lastError}</p>}
    {notice && <p className="offline-controls-notice" role="status">{notice}</p>}
    <div className="offline-completeness" role="status" aria-label={translateUI("本地副本完整性")}>
      <strong>{!enabled ? translateUI("自动保留已关闭") : status?.complete ? status.config.includeAssets ? translateUI("本地副本已完整") : translateUI("所选笔记已保存，未包含附件") : status?.pullState === "running" ? translateUI("正在保存本地副本，尚未完整") : status?.pullState === "error" ? translateUI("本地副本尚未完整，请稍后重试") : translateUI("本地副本尚未完整")}</strong>
      <p>{enabled ? translateUI("仅保存当前账号有权读取的内容。共享和只读笔记也会包含在可读取范围内；离线编辑仍受已有权限限制。") : translateUI("不会自动下载新的服务器内容；已有本地内容、待上传修改与独立备份会继续保留。")}</p>
      {enabled && <small>{translateUI("上次完整保存：")}{date(status?.lastDownload)}{translateUI(" · 最近保存：")}{date(status?.lastCacheUpdate)}</small>}
      {!!status?.assetsMissing && <small>{translateUI("还有 ")}{status.assetsMissing}{translateUI(" 个附件未保存，离线时可能无法打开。")}</small>}
      {!!status?.unavailable && <small>{translateUI("当前范围有 ")}{status.unavailable}{translateUI(" 项内容暂不可用。")}</small>}
    </div>
    <details className="offline-advanced"><summary>{translateUI("高级设置：保存范围与附件")}</summary>
      <fieldset disabled={!!busy || loading} className="offline-scope-options"><label>{translateUI("保存范围")}<select aria-label={translateUI("本地副本保存范围")} value={draft.scope} onChange={event => change({ scope: event.target.value as Config["scope"] })}><option value="all-readable">{translateUI("全部可读取的知识库")}</option><option value="selected">{translateUI("仅所选知识库")}</option></select></label>
      <p className="offline-controls-hint">{translateUI("全部范围会自动包含以后新增且有权读取的内容。选择部分知识库时，仅在这些库内保留本地副本。")}</p>
      </fieldset>
    {draft.scope === "selected" && <fieldset disabled={!!busy || loading} className="offline-library-picker"><legend>{translateUI("需要保留本地副本的知识库")}</legend>
      <div className="offline-library-options">{available.map(item => <label key={item.id}><input type="checkbox" aria-label={translateUI("离线知识库：{0}", [item.name])} checked={draft.libraryIds.includes(item.id)} onChange={event => change({ libraryIds: event.target.checked ? [...draft.libraryIds, item.id] : draft.libraryIds.filter(id => id !== item.id) })}/><span>{item.name}{item.team_name && <small>{item.team_name}</small>}</span></label>)}</div>
      {!available.length && <p>{translateUI("暂无可选择的知识库。连接服务器后刷新列表；已下载的副本会继续保留。")}</p>}
      {unknownSelections.length > 0 && <p className="offline-controls-hint">{translateUI("有 ")}{unknownSelections.length}{translateUI(" 个已选择的知识库暂不在可用列表中。")}<button type="button" onClick={() => change({ libraryIds: draft.libraryIds.filter(id => !unknownSelections.includes(id)) })}>{translateUI("移除这些选择")}</button></p>}
      <button type="button" onClick={() => void run(translateUI("正在刷新知识库…"), async () => { await refreshLibraries(); setNotice(translateUI("知识库列表已刷新")); })}>{translateUI("刷新知识库列表")}</button>
    </fieldset>}
    <label className="offline-checkbox"><input type="checkbox" aria-label={translateUI("同时下载图片、视频和其他附件")} checked={draft.includeAssets} disabled={!!busy || loading} onChange={event => change({ includeAssets: event.target.checked })}/><span>{translateUI("同时下载图片、视频和其他附件")}<small>{translateUI("包含全景图片和视频。取消后仅保存正文，离线时未下载的媒体无法打开。")}</small></span></label>
    </details>
    <div className="offline-controls-actions"><button type="button" disabled={!!busy || loading} onClick={() => void run(translateUI("正在保存设置…"), async () => { await save(); setNotice(translateUI("离线与备份设置已保存")); })}>{translateUI("保存设置")}</button>{enabled && <button type="button" disabled={!!busy || loading || !!status?.running} onClick={() => void run(translateUI("正在保存本地副本…"), async () => {
      if (dirty.current) { await save(); setNotice(translateUI("设置已保存，正在后台更新本地副本")); return; }
      if (!bridge.downloadOffline) throw new Error(translateUI("当前客户端不支持下载离线副本"));
      receive(await bridge.downloadOffline() as StorageStatus);
      setNotice(translateUI("本地副本已更新"));
    })}>{translateUI("立即更新本地副本")}</button>}</div>
    <div className="offline-storage-summary" aria-label={translateUI("离线副本状态")}><span>{translateUI("可离线查看的笔记 ")}{status?.availableDocuments ?? status?.documents ?? 0}{translateUI(" 篇")}</span><span>{translateUI("附件 ")}{status?.assets || 0} / {status?.assetsTotal ?? status?.assets ?? 0}{translateUI(" 个")}</span><span>{status?.pending || 0}{translateUI(" 篇待上传")}</span></div>
    {(progress || status?.running || busy) && <div className="offline-operation-progress" role="status">
      <p>{progress?.currentTitle || busy || translateUI("正在同步离线副本…")}</p>
      {progress && <><progress aria-label={translateUI("离线副本下载进度")} {...(progress.total > 0 ? { max: progress.total, value: Math.min(progress.completed, progress.total) } : {})}/><small>{translateUI("笔记 ")}{progress.completed} / {progress.total}{translateUI(" · 附件 ")}{progress.assetsCompleted} / {progress.assetsTotal}</small></>}
    </div>}
    {!!status?.pending && <div className="offline-controls-actions"><button type="button" disabled={!!busy || status.running} onClick={() => void run(translateUI("正在上传本地修改…"), async () => {
      if (!bridge.syncOffline) throw new Error(translateUI("当前客户端不支持同步离线副本"));
      receive(await bridge.syncOffline() as StorageStatus); setNotice(translateUI("已尝试上传本地修改，请查看待上传状态"));
    })}>{translateUI("重试上传本地修改")}</button></div>}
    {!!status?.conflicts?.length && <div className="offline-conflicts"><h4>{translateUI("需要处理的修改")}</h4><p>{translateUI("以下笔记的本地修改已保留，尚未上传。处理标题冲突时会合并正文，并保留处理前的本地副本。")}</p><ul>{status.conflicts.map(item => <li key={item.id}><strong>{item.title || translateUI("未命名笔记")}</strong><span>{item.error}</span>{item.remoteTitle !== undefined && <span>{translateUI("服务器标题：")}{item.remoteTitle || translateUI("未命名笔记")}</span>}{(item.kind === "title" || !item.kind && item.error.includes(translateUI("标题"))) && bridge.resolveOfflineConflict && <div className="offline-controls-actions">{([["local-title", translateUI("保留本地标题")], ["remote-title", translateUI("使用服务器标题")]] as const).map(([choice, label]) => <button type="button" key={choice} disabled={!!busy || !!status.running} onClick={() => void run(translateUI("正在处理标题冲突…"), async () => {
      receive(await bridge.resolveOfflineConflict!(item.id, choice) as StorageStatus);
      setNotice(translateUI("标题冲突已处理，正文与所选标题将在重新同步时上传"));
    })}>{label}</button>)}</div>}{item.kind==="archive"&&bridge.resolveOfflineConflict&&<div className="offline-controls-actions"><button type="button" disabled={!!busy||!!status.running} onClick={()=>void run(translateUI("正在检查知识库状态并保留原稿…"),async()=>{receive(await bridge.resolveOfflineConflict!(item.id,"local-title") as StorageStatus);setNotice(translateUI("已合并保留的草稿，可继续同步；处理前的副本仍保留"));})}>{translateUI("恢复知识库后合并草稿")}</button></div>}{item.kind==="validation"&&bridge.syncOffline&&<div className="offline-controls-actions"><button type="button" disabled={!!busy||!!status.running} onClick={()=>void run(translateUI("正在重试保存本地修改…"),async()=>{receive(await bridge.syncOffline!() as StorageStatus);setNotice(translateUI("已重试保存，请查看待上传与错误状态；本地原稿会保留"));})}>{translateUI("重试同步")}</button></div>}</li>)}</ul></div>}
    <section className="offline-backup-section" aria-label={translateUI("独立本地备份")}><h3>{translateUI("独立本地备份")}</h3><p>{translateUI("采用分块增量备份，正文修改只新增变化的分块，未变化的内容与附件复用已有数据；内容没有变化时不重复创建备份。可选择任一保留的时间点恢复，断网也可使用。仅包含本机已下载内容。")}</p>
      <p className="offline-controls-hint">{translateUI("升级后的首次备份会建立新的正文分块基线，后续修改按分块增量保存。旧版备份仍可恢复；迁移备份时请复制完整账号备份目录。")}</p>
      <div className="offline-backup-directory"><label htmlFor="offline-backup-directory">{translateUI("备份目录")}</label><div><input id="offline-backup-directory" aria-label={translateUI("备份目录")} readOnly value={draft.backupDirectory} placeholder={translateUI("尚未选择独立备份目录")}/><button type="button" disabled={!!busy || loading} onClick={() => void run(translateUI("正在选择备份目录…"), async () => {
        if (!bridge.chooseBackupDirectory) throw new Error(translateUI("当前客户端不支持选择备份目录"));
        const directory = await bridge.chooseBackupDirectory();
        if (directory) change({ backupDirectory: directory });
      })}>{translateUI("选择目录")}</button></div></div>
      <div className="offline-backup-options"><label>{translateUI("自动备份")}<select aria-label={translateUI("自动备份间隔")} value={interval} disabled={!!busy || loading} onChange={event => change({ backupIntervalMinutes: Number(event.target.value) })}>{intervals.map(value => <option key={value} value={value}>{value === 0 ? translateUI("关闭自动备份") : value === 1440 ? translateUI("每天") : value === 60 ? translateUI("每小时") : translateUI("每 {0} 分钟", [value])}</option>)}</select></label><label>{translateUI("备份保留")}<select aria-label={translateUI("备份保留数量")} value={draft.retention} disabled={!!busy || loading} onChange={event => change({ retention: Number(event.target.value) })}>{options.map(value => <option key={value} value={value}>{translateUI("最近 ")}{value}{translateUI(" 份")}</option>)}</select></label></div>
      <p className="offline-controls-hint">{translateUI("保留数量按备份时间点计算，不再使用的内容会自动清理；旧版完整备份仍可恢复。目录、间隔和数量在保存设置后生效，立即备份会先保存当前设置。")}</p>
      <div className="offline-controls-actions"><button type="button" className="offline-primary" disabled={backupBlocked} onClick={() => void run(translateUI("正在创建本地备份…"), async () => {
        if (!draft.backupDirectory) throw new Error(translateUI("请先选择独立备份目录"));
        const next = dirty.current || !status ? await save() : status;
        if (!bridge.createBackup) throw new Error(translateUI("当前客户端不支持本地备份"));
        const result = await bridge.createBackup();
        if (bridge.offlineStatus) receive(await bridge.offlineStatus() as StorageStatus);
        await readBackups(next.config.backupDirectory);
        setNotice(backupNotice(result));
      })}>{translateUI("立即备份")}</button><button type="button" disabled={!!busy || !configuredDirectory} onClick={() => void run(translateUI("正在打开备份目录…"), async () => {
        if (!bridge.openBackupFolder) throw new Error(translateUI("当前客户端不支持打开备份目录"));
        await bridge.openBackupFolder();
      })}>{translateUI("打开备份目录")}</button><button type="button" disabled={!!busy || !configuredDirectory} onClick={() => void run(translateUI("正在读取备份记录…"), () => readBackups(configuredDirectory))}>{translateUI("刷新备份列表")}</button></div>
      <p className="offline-backup-last">{translateUI("上次备份：")}{date(status?.lastBackup)}</p>
      <div className="offline-backup-list" aria-label={translateUI("本地备份列表")}>{displayedBackups.map(item => <article key={item.id}><div><strong>{date(item.createdAt || item.at)}</strong><small>{item.documents ?? 0}{translateUI(" 篇笔记")}{item.assets !== undefined ? translateUI(" · {0} 个附件", [item.assets]) : ""}{item.incremental ? translateUI(" · 增量备份{0}", [typeof item.addedBytes === "number" ? translateUI(" · 新增 {0}", [backupSize(item.addedBytes)]) : ""]) : item.incremental === false ? translateUI(" · 完整备份") : ""}</small></div><div className="offline-backup-item-actions"><button type="button" aria-label={translateUI("恢复备份：{0}", [date(item.createdAt || item.at)])} disabled={backupBlocked} onClick={() => setTarget(item)}>{translateUI("恢复")}</button><button type="button" className="offline-backup-delete" aria-label={translateUI("删除备份：{0}", [date(item.createdAt || item.at)])} disabled={backupBlocked || !bridge.deleteBackup} onClick={() => setDeleteTarget(item)}>{translateUI("删除")}</button></div></article>)}{!backups.length && <p>{translateUI("暂无当前账号的本地备份。")}</p>}</div>
      {!!backups.length && <nav className="offline-backup-pagination" aria-label={translateUI("本地备份分页")}><span aria-live="polite">{translateUI("共 ")}{backups.length}{translateUI(" 份 · 第 ")}{currentBackupPage} / {backupPages}{translateUI(" 页")}</span><div><button type="button" disabled={!!busy || loading || currentBackupPage <= 1} onClick={() => setBackupPage(currentBackupPage - 1)}>{translateUI("上一页")}</button><button type="button" disabled={!!busy || loading || currentBackupPage >= backupPages} onClick={() => setBackupPage(currentBackupPage + 1)}>{translateUI("下一页")}</button></div></nav>}
    </section>
    {target && <div className="modal academic-modal"><section ref={confirm} className="academic-dialog offline-restore-dialog" role="dialog" aria-label={translateUI("恢复本地备份")}><header><h2>{translateUI("恢复本地备份")}</h2><DialogClose disabled={!!busy} onClick={() => setTarget(null)}/></header><p>{translateUI("恢复 ")}{date(target.createdAt || target.at)}{translateUI(" 的备份（")}{target.documents ?? 0}{translateUI(" 篇笔记）？恢复前会先保留当前本地副本，便于找回现有修改。")}</p><p>{translateUI("恢复后的内容会标记为待上传，重新联网后同步到平台。")}</p><footer><button type="button" disabled={!!busy} onClick={() => setTarget(null)}>{translateUI("取消")}</button><button type="button" className="offline-primary" disabled={!!busy} onClick={() => void run(translateUI("正在恢复本地备份…"), async () => {
      if (!bridge.restoreBackup) throw new Error(translateUI("当前客户端不支持恢复本地备份"));
      const next = await bridge.restoreBackup(target.id) as StorageStatus;
      receive(next);
      await readBackups(next?.config?.backupDirectory || configuredDirectory);
      setTarget(null); setNotice(translateUI("本地备份已恢复，恢复前的副本已保留"));
    })}>{busy ? translateUI("正在恢复…") : translateUI("保留当前副本并恢复")}</button></footer></section></div>}
    {deleteTarget && <div className="modal academic-modal"><section ref={confirmDelete} className="academic-dialog offline-restore-dialog" role="dialog" aria-label={translateUI("删除本地备份")}><header><h2>{translateUI("删除本地备份")}</h2><DialogClose disabled={!!busy} onClick={() => setDeleteTarget(null)}/></header><p>{translateUI("删除 ")}{date(deleteTarget.createdAt || deleteTarget.at)}{translateUI(" 的备份（")}{deleteTarget.documents ?? 0}{translateUI(" 篇笔记）？此操作无法撤销。")}</p><p>{translateUI("只删除此备份时间点，并清理不再被其他备份使用的内容；当前笔记、附件及其他保留备份不受影响。")}</p>{backups.length === 1 ? <p className="offline-backup-delete-warning">{translateUI("这是当前账号唯一的本地备份。删除后将没有可用的备份恢复点。")}</p> : backups[0]?.id === deleteTarget.id && <p className="offline-backup-delete-warning">{translateUI("这是最新的本地备份。删除后只能恢复到较早的保留时间点。")}</p>}<footer><button type="button" disabled={!!busy} onClick={() => setDeleteTarget(null)}>{translateUI("取消")}</button><button type="button" className="offline-backup-delete" disabled={!!busy || backupBlocked} onClick={() => void run(translateUI("正在删除本地备份…"), async () => {
      if (!bridge.deleteBackup) throw new Error(translateUI("当前客户端不支持删除本地备份，请先更新客户端"));
      receive(await bridge.deleteBackup(deleteTarget.id) as StorageStatus);
      await readBackups(configuredDirectory);
      setDeleteTarget(null); setNotice(translateUI("本地备份已删除，当前笔记与其他备份已保留"));
    })}>{busy ? translateUI("正在删除…") : translateUI("删除备份")}</button></footer></section></div>}
  </section>;
}

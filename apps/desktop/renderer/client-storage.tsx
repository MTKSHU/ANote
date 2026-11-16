import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState } from "react";
import type { NativeState } from "./native";
import { useDialog } from "./dialog";

export function ClientStorage({ state }: { state: NativeState }) {
  const [directory, setDirectory] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void window.anote?.storageDirectory?.().then(value => { if (current) setDirectory(value.directory); }).catch(error => { if (current) setError(translateUI(message(error))); });
    return () => { current = false; };
  }, [state.serverURL, state.user?.id, state.workspace]);
  if (!window.anote?.migrateStorageDirectory) return null;
  return <div className="client-storage" data-testid="client-storage">
    <h3>{translateUI("笔记与附件工作目录")}</h3>
    <p style={{ overflowWrap: "anywhere" }}>{directory || translateUI("正在读取工作目录…")}</p>
    <p className="muted">{state.personal ? translateUI("个人知识库、笔记、附件和历史版本保存在此目录。") : translateUI("此账号的离线笔记、知识库目录、附件及待同步修改保存在此目录。")}{translateUI("迁移时校验全部文件后切换，原目录保留一份副本，可在确认后自行清理。")}</p>
    <button disabled={busy || !directory} onClick={async () => {
      setBusy(true); setError("");
      try { await window.anote.migrateStorageDirectory!(); }
      catch (error) { setError(translateUI(message(error))); }
      finally { setBusy(false); }
    }}>{busy ? translateUI("正在迁移…") : translateUI("更改并迁移工作目录")}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/, "");
}
export function StorageMigrationOverlay() {
  const [busy, setBusy] = useState(false), [switching, setSwitching] = useState(false), [restoring, setRestoring] = useState(false), [error, setError] = useState("");
  const dialog = useDialog<HTMLDivElement>(null, { open: busy });
  useEffect(() => {
    let current=true, revision=-1;
    const accept = (state: NativeState) => {
      if(!current||state.stateRevision<revision)return;
      revision=state.stateRevision;
      setBusy(!!state.storageMigrating||!!state.workspaceSwitching||!!state.backupRestoring);setSwitching(!!state.workspaceSwitching);setRestoring(!!state.backupRestoring);setError(translateUI(state.storageError||""));
    };
    void window.anote?.state().then(accept).catch(()=>{});
    const unsubscribe=window.anote?.onState(accept);
    return ()=>{current=false;unsubscribe?.();};
  }, []);
  const title=restoring?translateUI("正在恢复本地备份"):switching?translateUI("正在切换工作空间"):translateUI("正在迁移工作目录");
  return busy ? <div className="modal" style={{ zIndex: 5000 }}>
    <div className="modal-shell" role="alertdialog" aria-modal="true" aria-label={title} aria-busy="true" tabIndex={-1} ref={dialog}>
      <h2>{title}</h2>
      <p>{restoring?translateUI("正在保留当前稿并恢复所选备份，完成后自动重新打开笔记。"):switching?translateUI("正在保存当前笔记并打开所选工作空间，请稍候。"):translateUI("正在保存笔记、复制并校验附件。完成后会自动重新打开当前知识库。")}</p>
    </div>
  </div> : error ? <div className="client-update-banner" style={{bottom:"auto",top:72}} role="alert"><div>{error}</div><button onClick={()=>void window.anote?.retryStorageDirectory?.().catch(error=>setError(translateUI(message(error))))}>{translateUI("重新检查目录")}</button></div> : null;
}

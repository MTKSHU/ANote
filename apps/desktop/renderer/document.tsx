import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {createPortal} from "react-dom";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import {
  useResearchEditor,
  ResearchEditorContent,
  selectionAnchor,
  revealHeadingSection,
} from "@anote/editor";
import { findAnchor, resolveAnchor } from "@anote/document-model/anchors";
import {
  textOf,
  schema,
  EDITOR_SCHEMA_VERSION,
} from "@anote/document-model";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { request, type NativeState } from "./native";
import { flushDocument, waitForDocumentSync } from "./persistence";
import { EditorTools } from "./editor-tools";
import { Icon } from "./icons";
import { uploadTypes, type UploadCategory } from "./upload-types";
import { AttachmentPreview } from "./attachment-preview";
import { Sharing } from "./sharing";
import { uploadIntoEditor } from "./note-upload";
import { Annotations } from "./annotations";
import { useDialog, DialogClose } from "./dialog";
import { useDisclosureMenu } from "./disclosure-menu";
import { NotePanelHeader } from "./note-panel-header";
import { DocumentStatus, successfulDocumentStatus } from "./document-status";
import {usePageWidth,PageWidthMenu} from "./document-width";
import {exportNote,exportNoteMarkdown,type ExportSource} from "./note-export";
import {registerReloadGuard} from "./reload-guards";
import {NoteReferences,type NoteLinkTarget} from "./note-links";
import {cacheMetadata,createDocumentUpdateCapture,createSyncPendingIndicator,deferredDocumentSave} from "./document-save";
import {acquireDocumentSession,documentSessionOwner} from './document-session';
import {DocumentPreviewGate,type LivePreviewGate} from './document-preview';
import {applyDocumentMigrationEncoding,DOCUMENT_PROTOCOL_ORIGIN} from './document-migration-protocol';
import {DocumentLoading} from './document-loading';
import {useDocumentChrome} from './document-layout';

type DocumentProps={
  headerControls?:React.ReactNode;
  headerActions?:React.ReactNode;
  onDetails?: (metadata: any) => void;
  onBack?: () => void;
  onDelete?: () => void;
  state: NativeState;
  id: string;
  title: string;
  compact?:boolean;
  initiallyEditing?:boolean;
  onNotes?:()=>void;
  notesOpen?:boolean;
  noteTargets?:NoteLinkTarget[];
  onOpenNoteLink?:(id:string)=>void;
};
const localGate:LivePreviewGate={visible:true,onEditorReady:()=>{},onDenied:()=>{}};
export function Document(props:DocumentProps){
  if(props.state.personal)return <LiveDocument {...props} gate={localGate}/>;
  return <DocumentPreviewGate key={documentSessionOwner(props.state)+'|'+props.id} {...props} renderLive={gate=><LiveDocument {...props} gate={gate}/>}/>;
}
function LiveDocument({
  state,
  id,
  title,
  onDetails,
  onBack,
  onDelete,
  headerControls,
  headerActions,
  compact=false,
  initiallyEditing=false,
  onNotes,
  notesOpen=false,
  noteTargets=[],
  onOpenNoteLink,
  gate,
}:DocumentProps&{gate:LivePreviewGate}) {
  const [ready, setReady] = useState(false),
    [network, setNetwork] = useState("connecting"),
    [pending, setPending] = useState(0),
    [cached, setCached] = useState(false),
    [metadata, setMetadata] = useState<any>(null),
    [sharing, setSharing] = useState(false),
    [savingTitle, setSavingTitle] = useState(false),
    [panel, setPanel] = useState(""),
    [reading, setReading] = useState(compact&&!initiallyEditing),
    [outlineOpen, setOutlineOpen] = useState(false),
    [attachment, setAttachment] = useState(""),
    [manualStatus, setManualStatus] = useState(""),
    [error, setError] = useState("");
  const titleSave = useRef<(() => Promise<void>) | null>(null),
    localSave = useRef<(() => Promise<void>) | null>(null),
    nativeSave = useRef<(() => Promise<void>) | null>(null),
    scheduleNativeSave = useRef<(() => void) | null>(null),
    saveTask = useRef<Promise<void> | null>(null),
    editRevision = useRef(0);
  const reloadDocument=useRef<(()=>Promise<void>)|null>(null);
  useEffect(()=>{const changed=(event:Event)=>{const detail=(event as CustomEvent).detail;if(state.personal&&detail?.id===id&&detail.storeId===state.user?.id)void reloadDocument.current?.();};window.addEventListener('anote-local-document-changed',changed);return()=>window.removeEventListener('anote-local-document-changed',changed);},[id,state.personal,state.user?.id]);
  const documentConflict=state.offlineStorage?.conflicts.find(item=>item.id===id)?.kind||"";
  const exportSource=useRef<(()=>ExportSource)|null>(null),exportTitle=useRef<(()=>string)|null>(null),region=useRef<HTMLElement>(null);
  const [pastStart,setPastStart]=useState(false),[backRight,setBackRight]=useState(20);
  const floatingTarget=useDocumentChrome(region,`${!!metadata}:${gate.visible}`,true);
  const [exporting,setExporting]=useState(false);
  const [modeChanging,setModeChanging]=useState(false);
  const openLink=useRef(onOpenNoteLink);openLink.current=onOpenNoteLink;
  useEffect(()=>{
    const element=region.current;if(!element)return;
    const open=(event:Event)=>{const target=(event as CustomEvent).detail?.id;if(typeof target!=="string"||!/^[-\w]{1,80}$/.test(target)||!openLink.current)return;event.preventDefault();openLink.current(target);};
    element.addEventListener("anote-open-note",open);return()=>element.removeEventListener("anote-open-note",open);
  },[id]);
  async function toggleReading(){
    if(modeChanging)return;
    setModeChanging(true);
    try{
      if(!reading){if(region.current?.querySelector('[data-composing="true"]'))throw new Error(translateUI("请先完成当前输入，再切换阅读模式"));await flushDocument(runtime.persistence,runtime.document);await titleSave.current?.();await localSave.current?.();await nativeSave.current?.();}
      setReading(value=>!value);setManualStatus("");
    }catch(error){setError(translateUI((error as Error).message));}finally{setModeChanging(false);}
  }
  async function downloadNote(format='pdf'){
    if(exporting||!exportSource.current||!metadata)return;
    setExporting(true);setManualStatus(translateUI("正在准备导出…"));
    try{const source=exportSource.current(),currentTitle=exportTitle.current?.()||metadata.title||title;setManualStatus(format==='md'?await exportNoteMarkdown(source,currentTitle,state.serverURL,setManualStatus):await exportNote(source,currentTitle,state.serverURL));}
    catch(error){setManualStatus(translateUI("导出未完成"));setError(translateUI((error as Error).message));}finally{setExporting(false);}
  }
  const saveContext = useRef({metadata, ready, reading, state, network});
  const observedArchive=useRef<{key:string;archived:boolean}|null>(null);
  useEffect(()=>{
    if(!metadata||metadata.id!==id)return;
    const key=state.serverURL+"|"+state.user?.id+"|"+id,archived=!!metadata.library_archived;
    const previous=observedArchive.current;observedArchive.current={key,archived};
    // Refresh navigation once on a live permission transition, never on note switches.
    if(previous?.key===key&&previous.archived!==archived)window.dispatchEvent(new Event("anote-note-changed"));
  },[id,state.serverURL,state.user?.id,metadata?.library_archived,metadata?.id]);
  const noteMenu = useDisclosureMenu();
  const [pageWidth,setPageWidth]=usePageWidth(state.serverURL,state.user!.id);
  saveContext.current = {metadata, ready, reading, state, network};
  const runtime = useMemo(() => {
    const syncPending=createSyncPendingIndicator(setPending);
    if(!state.personal&&!state.validationMode){const lease=acquireDocumentSession(state,id,gate.initialStateEncoding);return {...lease.value,ready:lease.ready,syncPending,lease};}
    const document = new Y.Doc();
    const
      persistence = new IndexeddbPersistence(
        `anote:${state.serverURL}:${state.user!.id}:${id}`,
        document,
      ),
      socket = state.personal
        ? undefined
        : new HocuspocusProviderWebsocket({
            url: state.serverURL.replace(/^http/, "ws") + "/collab",
            autoConnect: false,
          }),
      provider = socket
        ? new HocuspocusProvider({
            websocketProvider: socket,
            name: id,
            document,
            token: state.validationMode
              ? state.token || ""
              : JSON.stringify({
                  token: state.token || "",
                  schema: EDITOR_SCHEMA_VERSION,
                  migrationEncoding:2,
                }),
            onStatus: ({ status }) => setNetwork(status),
            onSynced: ({ state: synced }) => {
              if (synced) setReady(true);
            },
            onAuthenticationFailed: ({ reason }) => {
              setMetadata(null);
              setError(translateUI(reason || translateUI("会话或知识库权限已变化，请重新连接")));
              gate.onDenied(reason||translateUI("会话或知识库权限已变化，请重新连接"));
            },
            onUnsyncedChanges: ({ number }) => syncPending.update(number),
          })
        : undefined;
    provider?.attach();
    const ready=persistence.whenSynced.then(()=>applyDocumentMigrationEncoding(document,gate.initialStateEncoding));
    return { document, persistence, provider, socket, ready,syncPending, hydrated:{ystate:"",hash:""},lease:undefined };
  }, [documentSessionOwner(state),id,state.validationMode]);
  useEffect(()=>registerReloadGuard(async()=>{
    if(region.current?.querySelector('[data-composing="true"]'))throw new Error(translateUI("请先完成当前输入，再刷新页面"));
    exportTitle.current?.();
    await flushDocument(runtime.persistence,runtime.document);
    await titleSave.current?.();
    await localSave.current?.();
    await nativeSave.current?.();
    await runtime.lease?.value.savePreview();
  }),[id,runtime]);
  useEffect(() => {
    let current = true;
    runtime.lease?.activate();runtime.lease?.value.begin();
    const unsubscribe=runtime.lease?.value.subscribe({
      status:setNetwork,synced:()=>setReady(true),pending:count=>runtime.syncPending.update(count),
      failed:reason=>{runtime.lease?.invalidate();setMetadata(null);setError(translateUI(reason||translateUI("会话或知识库权限已变化，请重新连接")));gate.onDenied(reason||translateUI("会话或知识库权限已变化，请重新连接"));},
      saveError:error=>setError(translateUI("本地副本保存失败：{0}", [(error as Error).message])),
    });
    runtime.ready
      .then(() => {
        if (current) {
          setCached(true);
          if (runtime.document.getXmlFragment("default").length) setReady(true);
        }
      })
      .catch((e) => setError(translateUI(e.message)));
    return () => {
      current = false;
      unsubscribe?.();
      runtime.syncPending.dispose();
      if(runtime.lease){runtime.lease.release();return;}
      runtime.provider?.destroy();
      runtime.socket?.destroy();
      const saveNative=nativeSave.current,saveLocal=localSave.current;
      void Promise.allSettled([Promise.resolve().then(()=>saveLocal?.()),Promise.resolve().then(()=>saveNative?.())]).finally(async()=>{await runtime.persistence.destroy();runtime.document.destroy();});
    };
  }, [runtime]);
  useEffect(
    () =>
      window.anote?.onBeforeClose?.(async () => {
        if(region.current?.querySelector('[data-composing="true"]'))throw new Error(translateUI("请先完成当前输入，再保存并关闭"));
        exportTitle.current?.();
        await flushDocument(runtime.persistence, runtime.document);
        await titleSave.current?.();
        await localSave.current?.();
        await nativeSave.current?.();
        await runtime.lease?.value.savePreview();
      }),
    [runtime],
  );
  useEffect(() => {
    if (state.offline || !metadata || metadata.offline_new || state.offlineStorage?.conflicts.some(item=>item.id===id)) runtime.socket?.disconnect();
    else void runtime.socket?.connect().catch((e) => setError(translateUI(e.message)));
  }, [state.offline, !!metadata, metadata?.offline_new, state.offlineStorage?.conflicts.some(item=>item.id===id), runtime]);
  useEffect(() => {
    let current = true;
    let loading:Promise<void>|null=null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (): Promise<void> => {
      if(loading)return loading;
      clearTimeout(retry);
      const query=state.personal
        ? runtime.hydrated.hash?"?known_hash="+encodeURIComponent(runtime.hydrated.hash):""
        : "?content=metadata"+(runtime.lease&&state.desktop===true?"&access_check=1":"");
      const task=request(`documents/${id}${query}`)
        .then(async (value) => {
          await runtime.ready;if(!current)return;
          if (state.personal || state.desktop === true) {
            if (globalThis.document.querySelector('.research-editor[data-composing="true"]')) return;
            // Full CRDT states are idempotent, but decoding and applying the
            // same large state on every local poll still blocks the renderer.
            if (value.ystate&&value.ystate!==runtime.hydrated.ystate) {
              Y.applyUpdate(
                runtime.document,
                Uint8Array.from(atob(value.ystate), (c) => c.charCodeAt(0)),
              );
              runtime.hydrated.ystate=value.ystate;
            }
            if(value.hash)runtime.hydrated.hash=value.hash;
            // Online metadata must not mount an empty editor before its first
            // collaboration sync. Offline/local responses still contain the
            // complete state, while IndexedDB can supply an existing draft.
            if(value.ystate || runtime.document.getXmlFragment("default").length)
              setReady(true);
            if(state.personal)setNetwork("local");
          }
          if (current) {
            applyDocumentMigrationEncoding(runtime.document,value.state_encoding);
            const next=cacheMetadata(value);delete next.unchanged;
            setMetadata((previous:any)=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
            setError(translateUI(value.sync_warning || ""));
          }
        })
        .catch((error) => {
          if (current) {
            if ([401, 403, 404].includes(error.status)){runtime.lease?.invalidate();runtime.lease?.value.authorize(null,false);setMetadata(null);gate.onDenied(error.message);}
            setError(translateUI(error.message));
            if (!state.offline && ![401, 403, 404].includes(error.status))
              retry = setTimeout(load, 1500);
          }
        }).finally(()=>{if(loading===task)loading=null;});
      loading=task;return task;
    };
    reloadDocument.current=load;
    void load();
    const timer = state.personal
      ? setInterval(() => void load(), 2000)
      : undefined;
    return () => {
      current = false;
      clearTimeout(retry);
      clearInterval(timer);
      if(reloadDocument.current===load)reloadDocument.current=null;
    };
  }, [
    id,
    state.serverURL,
    state.user?.id,
    state.offline,
    state.token,
    documentConflict,
    network,
  ]);
  useEffect(()=>{
    // A newly-created offline note needs fresh server metadata once upload
    // completes. Other notes' pending counters must not reload this body.
    if(metadata?.offline_new&&state.offlineStorage?.pending===0)void reloadDocument.current?.();
  },[metadata?.offline_new,state.offlineStorage?.pending]);
  useEffect(()=>{runtime.lease?.value.authorize(metadata,ready);},[runtime,metadata,ready]);
  useEffect(()=>{
    if(state.personal || state.desktop!==true || !window.anote?.cacheOfflineDocument)return;
    if(runtime.lease){
      const value=runtime.lease.value,save=()=>value.saveNative();nativeSave.current=save;value.composing(()=>!!region.current?.querySelector('[data-composing="true"]'));
      return()=>{value.composing(null);if(nativeSave.current===save)nativeSave.current=null;};
    }
    const identity={serverURL:state.serverURL,userId:state.user!.id};
    let active=true,localRevision=0,savedLocalRevision=0;
    const updates=createDocumentUpdateCapture(runtime.document);
    const saver=deferredDocumentSave({
      canSave:()=>{const current=saveContext.current;return !!current.ready&&!!current.metadata&&!current.metadata.archived&&!current.metadata.library_archived&&["admin","editor"].includes(current.metadata.role||current.state.user?.role);},
      isComposing:()=>!!region.current?.querySelector('[data-composing="true"]'),
      capture:()=>{const batch=updates.capture();return {batch,revision:localRevision,payload:{id,ystate:batch.ystate,metadata:cacheMetadata(saveContext.current.metadata),local:localRevision>savedLocalRevision,...identity}};},
      write:async value=>{await window.anote!.cacheOfflineDocument!(value.payload);updates.acknowledge(value.batch);savedLocalRevision=Math.max(savedLocalRevision,value.revision);},
      onError:error=>{if(active)setError(translateUI("本地副本保存失败：{0}", [(error as Error).message]));},
    });
    const save=()=>saver.flush(),schedule=()=>saver.markDirty();
    const changed=(_update?:Uint8Array,origin?:unknown,_document?:Y.Doc,transaction?:Y.Transaction)=>{if(transaction?.local&&origin!==DOCUMENT_PROTOCOL_ORIGIN)localRevision++;schedule();};
    nativeSave.current=save;scheduleNativeSave.current=schedule;runtime.document.on("update",changed);
    void runtime.persistence.whenSynced.then(()=>{if(active)schedule();});
    return()=>{active=false;saver.dispose();runtime.document.off("update",changed);void save().catch(()=>{}).finally(()=>updates.dispose());if(nativeSave.current===save)nativeSave.current=null;if(scheduleNativeSave.current===schedule)scheduleNativeSave.current=null;};
  },[id,runtime,state.personal,state.desktop]);
  useEffect(()=>{if(ready&&metadata?.id)scheduleNativeSave.current?.();},[ready,metadata?.id]);
  useEffect(() => {
    const show = (event: Event) => setAttachment((event as CustomEvent).detail);
    window.addEventListener("anote-preview-asset", show);
    return () => window.removeEventListener("anote-preview-asset", show);
  }, [id]);
  useEffect(()=>{
    if(state.personal||state.offline)return;
    let live=true,loading=false;
    const refresh=async()=>{if(loading)return;loading=true;try{const info=await request(`documents/${id}/info`);if(live)setMetadata((value:any)=>value?{...value,tags:info.tags,updated_at:info.updated_at,last_editors:info.last_editors}:value);}catch(error){if(live&&[401,403,404].includes((error as any).status)){runtime.lease?.invalidate();runtime.lease?.value.authorize(null,false);setMetadata(null);gate.onDenied((error as Error).message);}}finally{loading=false;}};
    window.addEventListener("anote-note-changed",refresh);window.addEventListener("anote-note-info-changed",refresh);
    const timer=setInterval(()=>void refresh(),10000);
    return()=>{live=false;clearInterval(timer);window.removeEventListener("anote-note-changed",refresh);window.removeEventListener("anote-note-info-changed",refresh);};
  },[id,state.personal,state.offline,state.serverURL,state.user?.id]);
  useEffect(() => {
    const changed = (_update:Uint8Array,origin:unknown) => { if(origin===DOCUMENT_PROTOCOL_ORIGIN)return;editRevision.current++; setManualStatus(""); };
    runtime.document.on("update", changed);
    return () => { runtime.document.off("update", changed); };
  }, [runtime]);
  useEffect(() => {
    let active = true;
    saveTask.current = null;
    setManualStatus("");
    const save = async () => {
      const {metadata, ready, reading, state, network} = saveContext.current;
      if (!metadata || !ready) { setManualStatus(translateUI("笔记尚未就绪，请稍后保存")); return; }
      if (reading || metadata.archived || metadata.library_archived || !["admin", "editor"].includes(metadata.role || state.user?.role)) {
        setManualStatus(translateUI("当前为只读笔记，无需保存")); return;
      }
      const revision = editRevision.current;
      const saveTitle = titleSave.current, saveLocal = localSave.current;
      setManualStatus(translateUI("正在保存…"));
      let cached = false;
      try {
        await flushDocument(runtime.persistence, runtime.document);
        await saveTitle?.();
        await nativeSave.current?.();
        await runtime.lease?.value.savePreview();
        cached = true;
        if (!active) return;
        if (!state.personal && (state.offline || network !== "connected" || !navigator.onLine)) {
          if (active) setManualStatus(translateUI("正文已缓存到本机，尚未同步到服务器"));
          return;
        }
        await saveTitle?.();
        if (!active) return;
        if (state.personal) {
          if (!saveLocal) throw new Error(translateUI("本地保存尚未就绪"));
          await saveLocal();
        }
        else {
          await waitForDocumentSync(runtime.provider!);
          if (!active) return;
          await request(`documents/${id}/save`, "POST");
          await runtime.lease?.value.savePreview();
        }
        if (active) {
          setError("");
          window.dispatchEvent(new Event("anote-note-info-changed"));
          setManualStatus(editRevision.current === revision ? state.personal ? translateUI("已保存到本地") : translateUI("已保存") : "");
        }
      } catch (error) {
        if (active) {
          setManualStatus(translateUI("保存未完成"));
          setError(translateUI("{0}保存未完成：{1}", [(cached ? translateUI("正文已缓存到本机；") : ""), (error as Error).message]));
        }
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
      // Leave settings, sharing and other independent forms to their own UI.
      if (event.target instanceof Element && event.target.closest('.modal,[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.isComposing) { setManualStatus(translateUI("请先完成当前输入，再保存")); return; }
      if (!event.repeat && !saveTask.current) {
        const task = save();
        saveTask.current = task;
        void task.finally(() => { if (saveTask.current === task) saveTask.current = null; });
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => { active = false; window.removeEventListener("keydown", keydown, true); };
  }, [id, runtime]);
  const canEdit = gate.visible && ready && !state.storageError && !!metadata && !metadata.archived && !metadata.library_archived && !state.offlineStorage?.conflicts.some(item=>item.id===id&&item.kind!=="validation") && ["admin", "editor"].includes(metadata.role || state.user?.role);
  const isDocumentReady=ready&&!!metadata;
  useEffect(()=>{
    const element=region.current;if(!element||!isDocumentReady){setPastStart(false);return;}
    let paper:HTMLElement|null=null;
    const observer=new ResizeObserver(update);
    function update(){
      // The editor mounts after its document is ready; discover its paper when scrolling starts.
      const nextPaper=element!.querySelector<HTMLElement>('.paper');
      if(paper!==nextPaper){if(paper)observer.unobserve(paper);paper=nextPaper;if(paper)observer.observe(paper);}
      setPastStart(element!.scrollTop>Math.max(500,element!.clientHeight*.8));
      if(paper)setBackRight(Math.min(window.innerWidth-56,Math.max(20,window.innerWidth-paper.getBoundingClientRect().right+20)));
    }
    update();element.addEventListener('scroll',update,{passive:true});observer.observe(element);window.addEventListener('resize',update);
    return()=>{element.removeEventListener('scroll',update);observer.disconnect();window.removeEventListener('resize',update);};
  },[id,isDocumentReady]);
  const visibleManualStatus = successfulDocumentStatus(manualStatus) && !state.personal && (state.offline || network !== "connected") ? "" : manualStatus;
  const syncMessage = visibleManualStatus || (savingTitle ? translateUI("正在保存标题…") : state.personal ? pending ? translateUI("正在保存…") : translateUI("已保存到本地") : state.offline ? translateUI("离线编辑") : network === "connected" ? pending ? translateUI("正在同步…") : translateUI("已同步") : translateUI("等待连接"));
  return (
    <section ref={region} className="document-region" style={gate.visible?undefined:{display:'none'}} aria-hidden={!gate.visible||undefined} data-view-ready={gate.visible&&isDocumentReady} data-edit-ready={gate.visible&&isDocumentReady} data-sync-ready={network==='connected'&&ready&&!!runtime.provider?.isSynced&&!runtime.provider?.hasUnsyncedChanges} data-page-width={pageWidth} data-mobile-reading={compact?(reading?"read":"edit"):undefined}>
      <div className="document-header academic-document-header">
        {headerControls}
        {onNotes&&<button className="mobile-note-list-trigger" aria-label={translateUI("显示笔记列表")} title={translateUI("同库笔记")} aria-haspopup="dialog" aria-expanded={notesOpen} onClick={onNotes}><Icon name="list" size={19}/></button>}
        {onBack && (
          <button
            className="document-back"
            aria-label={translateUI("返回知识库")}
            title={translateUI("返回知识库")}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
        )}
        <button
          className={"outline-toggle" + (outlineOpen ? " active" : "")}
          aria-label={outlineOpen ? translateUI("隐藏文内目录") : translateUI("显示文内目录")}
          title={outlineOpen ? translateUI("隐藏文内目录") : translateUI("显示文内目录")}
          aria-expanded={outlineOpen}
          onClick={() => {
            setOutlineOpen((v) => !v);
            setPanel("");
          }}
        >
          <Icon name="menu" />
        </button>
        <div className="document-title-wrap">
          <NoteTitle
            id={id}
            title={metadata?.title || title}
            editable={
              canEdit && !reading
            }
            onSaving={setSavingTitle}
            saveRef={titleSave}
            exportRef={exportTitle}
            onDirty={() => { editRevision.current++; setManualStatus(""); }}
            onSaved={(value) =>
              setMetadata((v: any) => ({ ...v, title: value }))
            }
          />
        </div>
        <div className="workspace-header-actions">
        <div className="document-actions">
          {!compact&&<DocumentStatus message={syncMessage} cached={cached}/>}
          <PageWidthMenu value={pageWidth} onChange={setPageWidth}/>
          <button className="document-mode-toggle" aria-label={canEdit && reading ? translateUI("编辑") : translateUI("阅读")} data-mode={reading || !canEdit ? "read" : "edit"} title={!canEdit ? translateUI("当前为只读笔记") : reading ? translateUI("返回编辑模式") : translateUI("进入阅读模式")} disabled={!ready || !canEdit||modeChanging} onClick={()=>void toggleReading()}>
            <Icon name={reading && canEdit ? "edit" : "read"}/>
            <span>{canEdit && reading ? translateUI("编辑") : translateUI("阅读")}</span>
          </button>
          {!state.personal && (
            <button
              aria-label={translateUI("评论")}
              title={translateUI("评论")}
              className={panel === "comments" ? "active" : ""}
              onClick={() => {
                setOutlineOpen(false);
                setPanel(panel === "comments" ? "" : "comments");
              }}
            >
              <Icon name="comment" />
              <span>{translateUI("评论")}</span>
            </button>
          )}
          {metadata?.space_id && (
            <button
              aria-label={translateUI("历史版本")}
              title={translateUI("历史版本")}
              className={panel === "history" ? "active" : ""}
              onClick={() => {
                setOutlineOpen(false);
                setPanel(panel === "history" ? "" : "history");
              }}
            >
              <Icon name="history" />
              <span>{translateUI("历史版本")}</span>
            </button>
          )}
          {metadata?.space_id && !state.personal && (
            <button
              className="note-share-button"
              title={
                metadata.visibility === "team"
                  ? translateUI("内/外共享 · 团队可见")
                  : metadata.collaborator_count
                    ? translateUI("内/外共享 · 指定成员可见")
                    : translateUI("内/外共享 · 仅自己可见")
              }
              onClick={() => setSharing(true)}
            >
              <Icon name="share" />
              <span>{translateUI("共享")}</span>
            </button>
          )}
          <details
            ref={noteMenu}
            className="note-more"
            onClick={(e) => {
              if ((e.target as Element).closest("button"))
                e.currentTarget.removeAttribute("open");
            }}
          >
            <summary role="button" aria-label={translateUI("笔记更多操作")}>
              <Icon name="more" />
            </summary>
            <div>
              {compact&&<button onClick={()=>{setOutlineOpen(value=>!value);setPanel("");}}><Icon name="list"/>{translateUI("文内目录")}</button>}
              {compact&&!state.personal&&<button onClick={()=>{setOutlineOpen(false);setPanel(panel==="comments"?"":"comments");}}><Icon name="comment"/>{translateUI("评论")}</button>}
              {compact&&metadata?.space_id&&<button onClick={()=>{setOutlineOpen(false);setPanel(panel==="history"?"":"history");}}><Icon name="history"/>{translateUI("历史版本")}</button>}
              {compact&&metadata?.space_id&&!state.personal&&<button onClick={()=>setSharing(true)}><Icon name="share"/>{translateUI("共享")}</button>}
              <button disabled={exporting||!ready||!metadata} onClick={()=>void downloadNote()}><Icon name="file"/>{state.desktop!==false?translateUI("导出 PDF"):translateUI("打印／保存 PDF")}</button>
              <button title={translateUI("含附件时导出 ZIP，解压后包含 .md 和 assets 目录")} disabled={exporting||!ready||!metadata} onClick={()=>void downloadNote('md')}><Icon name="file"/>{translateUI("导出 Markdown（.md）")}</button>
              {state.desktop !== false && state.validationMode && !state.personal && (
                <button
                  onClick={() => setPanel(panel === "sync" ? "" : "sync")}
                >
                  <Icon name="sync" />{translateUI("本地同步 ")}</button>
              )}
              {onDetails && (
                <button
                  disabled={savingTitle || !metadata || !!metadata.library_archived}
                  onClick={() => onDetails(metadata)}
                >
                  <Icon name="settings" />{translateUI("笔记设置 ")}</button>
              )}
              {onDelete && metadata?.can_manage && (
                <button className="danger-action" onClick={onDelete}>
                  <Icon name="trash" />{translateUI("删除笔记 ")}</button>
              )}
            </div>
          </details>
        </div>
        {headerActions}
        </div>
      </div>
      {attachment && (
        <AttachmentPreview
          id={attachment}
          onClose={() => setAttachment("")}
          onError={setError}
        />
      )}
      {error && ready && (
        <div className="note-error" role="alert">
          {error}
          <button onClick={() => setError("")}>{translateUI("关闭")}</button>
        </div>
      )}
      {metadata&&<div className="document-info" aria-label={translateUI("笔记信息")}>
        {compact&&<DocumentStatus message={syncMessage} cached={cached}/>}
        <span title={translateUI("编辑者：{0}", [(metadata.last_editors?.map((person:{name:string})=>person.name).join("、")||translateUI("未记录"))])}>{translateUI("编辑者：")}{metadata.last_editors?.map((person:{name:string})=>person.name).join("、")||translateUI("未记录")}</span>
        {metadata.updated_at&&<time dateTime={metadata.updated_at}>{translateUI("更新时间：")}{new Date(metadata.updated_at).toLocaleString(uiLocale(),{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</time>}
        <span className="document-tags">{metadata.library_archived&&<span className="library-archive-badge">{translateUI("知识库已归档 · 只读")}</span>}<span>{translateUI("标签：")}</span>{metadata.tags?.length?metadata.tags.map((tag:string)=><span className="document-tag" title={tag} key={tag}>{tag}</span>):<span>{translateUI("无标签")}</span>}</span>
      </div>}
      {sharing && metadata?.space_id && (
        <Sharing
          id={id}
          space={metadata.space_id}
          serverURL={state.serverURL}
          onClose={() => setSharing(false)}
          onChanged={() => {
            void request(`documents/${id}`).then(setMetadata);
            window.dispatchEvent(new Event("anote-note-changed"));
          }}
        />
      )}
      {ready && metadata ? (
        <Editor
          state={state}
          onLocalPending={setPending}
          id={id}
          runtime={runtime}
          saveRef={localSave}
          exportSource={exportSource}
          pending={pending}
          metadata={metadata}
          panel={panel}
          setPanel={(value) => {
            if (value) setOutlineOpen(false);
            setPanel(value);
          }}
          reading={reading}
          outlineOpen={outlineOpen}
          onCloseOutline={() => setOutlineOpen(false)}
          noteTargets={noteTargets}
          onOpenNoteLink={onOpenNoteLink}
          floatingTarget={floatingTarget}
          interactionReady={gate.visible}
          onEditorReady={()=>gate.onEditorReady(region.current)}
        />
      ) : (
        <DocumentLoading requestKey={id} pending={gate.visible} error={gate.visible?error:''} message={translateUI("正在准备笔记")} hint={!state.personal&&network!=="connected"?translateUI("首次打开需要连接服务器；已经缓存的笔记可以离线使用。"):undefined}/>
      )}
      {isDocumentReady&&pastStart&&<button type="button" className="note-back-to-top" style={{right:backRight}} aria-label={translateUI("回到开头")} title={translateUI("回到开头")} onClick={()=>region.current?.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}><Icon name="to-top" size={19}/></button>}
    </section>
  );
}
function NotePanelPortal({target,children}:{target:HTMLElement|null;children:React.ReactNode}){return target?createPortal(children,target):children;}
function DocumentOutline({
  editor,
  onClose,
}: {
  editor: ReturnType<typeof useResearchEditor>;
  onClose: () => void;
}) {
  const [headings, setHeadings] = useState<
    { key: string; label: string; level: number; pos: number }[]
  >([]);
  const [active, setActive] = useState("");
  const firstLevel = Math.min(5, ...headings.map(heading => heading.level));
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout>;
    const collect = () => {
      const next: typeof headings = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading")
          next.push({
            key: node.attrs.blockId || String(pos),
            label: node.textContent || translateUI("未命名标题"),
            level: node.attrs.level,
            pos,
          });
      });
      setHeadings(next);
    };
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(collect, 120);
    };
    collect();
    editor.on("update", changed);
    return () => {
      clearTimeout(timer);
      editor.off("update", changed);
    };
  }, [editor]);
  return (
    <aside className="document-outline floating-note-panel" aria-label={translateUI("文内目录")}>
      <header>
        <strong>{translateUI("文内目录")}</strong>
        <button aria-label={translateUI("隐藏文内目录")} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <nav aria-label={translateUI("笔记标题大纲")}>
        {headings.map((heading) => (
          <button
            key={heading.key}
            className={active === heading.key ? "active" : ""}
            data-heading-level={heading.level}
            style={{ paddingInlineStart: 12 + (heading.level - firstLevel) * 20 }}
            title={heading.label}
            onClick={() => {
              if (!editor) return;
              let position = heading.pos;
              editor.state.doc.descendants((node, pos) => {
                if (
                  node.type.name === "heading" &&
                  node.attrs.blockId === heading.key
                )
                  position = pos;
              });
              revealHeadingSection(editor,position);
              const element = editor.view.nodeDOM(position);
              if (element instanceof HTMLElement) {
                element.scrollIntoView({ behavior: "smooth", block: "start" });
                setActive(heading.key);
              }
            }}
          >
            <span>{heading.label}</span>
          </button>
        ))}
      </nav>
      {!headings.length && (
        <p>{translateUI("为段落设置 H1–H5 标题后，会在这里显示。编辑时可输入 / 选择标题。")}</p>
      )}
    </aside>
  );
}
function NoteTitle({
  id,
  title,
  editable,
  onSaved,
  onSaving,
  saveRef,
  exportRef,
  onDirty,
}: {
  id: string;
  title: string;
  editable: boolean;
  onSaved: (value: string) => void;
  onSaving: (value: boolean) => void;
  saveRef: React.MutableRefObject<(() => Promise<void>) | null>;
  exportRef: React.MutableRefObject<(() => string) | null>;
  onDirty: () => void;
}) {
  const [draft, setDraft] = useState(title),
    [error, setError] = useState("");
  const composing = useRef(false),latest = useRef(title),
    saved = useRef(title),
    dirty = useRef(false),
    revision = useRef(0),
    pending = useRef(0),
    queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!dirty.current && !pending.current) {
      latest.current = title;
      saved.current = title;
      setDraft(title);
    }
  }, [title]);
  function save() {
    if (!editable) return Promise.resolve();
    const value = latest.current.trim(),
      version = revision.current;
    if (!value) {
      latest.current = saved.current;
      dirty.current = false;
      setDraft(saved.current);
      return Promise.resolve();
    }
    if (value === saved.current && !pending.current) {
      dirty.current = false;
      return Promise.resolve();
    }
    pending.current++;
    onSaving(true);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        await request(`documents/${id}`, "PATCH", { title: value });
        saved.current = value;
        if (version === revision.current) {
          dirty.current = false;
          setDraft(value);
          onSaved(value);
          setError("");
          window.dispatchEvent(new Event("anote-note-changed"));
        }
      })
      .catch((e) => {
        if (version === revision.current) setError(translateUI(e.message));
        throw e;
      })
      .finally(() => {
        pending.current--;
        onSaving(pending.current > 0);
      });
    return queue.current;
  }
  useEffect(() => {
    saveRef.current = save;
    const currentTitle=()=>{if(composing.current)throw new Error(translateUI("请先完成当前输入，再导出笔记"));return latest.current.trim()||saved.current;};
    exportRef.current=currentTitle;
    return () => { if (saveRef.current === save) saveRef.current = null;if(exportRef.current===currentTitle)exportRef.current=null; };
  });
  return (
    <>
      <input
        className="note-title"
        aria-label={translateUI("笔记标题")}
        value={draft}
        maxLength={200}
        readOnly={!editable}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onChange={(e) => {
          latest.current = e.target.value;
          dirty.current = true;
          revision.current++;
          setDraft(e.target.value);
          onDirty();
        }}
        onBlur={() => void save().catch(() => {})}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </>
  );
}
function Editor({
  state,
  id,
  runtime,
  pending,
  metadata,
  panel,
  setPanel,
  reading,
  outlineOpen,
  onCloseOutline,
  onLocalPending,
  saveRef,
  exportSource,
  noteTargets,
  onOpenNoteLink,
  interactionReady,
  onEditorReady,
  floatingTarget,
}: {
  state: NativeState;
  id: string;
  runtime: {
    document: Y.Doc;
    persistence: IndexeddbPersistence;
    provider?: HocuspocusProvider;
  };
  pending: number;
  metadata: any;
  panel: string;
  setPanel: (value: string) => void;
  reading: boolean;
  outlineOpen: boolean;
  onCloseOutline: () => void;
  onLocalPending: (value: number) => void;
  saveRef: React.MutableRefObject<(() => Promise<void>) | null>;
  exportSource:React.MutableRefObject<(()=>ExportSource)|null>;
  noteTargets:NoteLinkTarget[];
  onOpenNoteLink?:(id:string)=>void;
  interactionReady:boolean;
  onEditorReady:()=>void;
  floatingTarget:HTMLElement|null;
}) {
  const [notice, setNotice] = useState(""),
    [quote, setQuote] = useState(""),
    [commentAnchor, setCommentAnchor] = useState<any>(null),
    [text, setText] = useState(""),
    [comments, setComments] = useState<any[]>([]),
    [versions, setVersions] = useState<any[]>([]),
    [preview, setPreview] = useState<any>(null),
    [versionLabel, setVersionLabel] = useState(""),
    [versionName,setVersionName]=useState(""),
    [historyTab,setHistoryTab]=useState<"automatic"|"named">("automatic"),
    [reply, setReply] = useState<Record<string, string>>({});
  const [upload, setUpload] = useState("");
  const [commentRequest, setCommentRequest] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null),
    uploadCategory = useRef<UploadCategory | null>(null),
    transfer = useRef<AbortController | null>(null);
  const role = metadata.role || state.user?.role;
  const editable = interactionReady && ["admin", "editor"].includes(role) && !metadata.archived && !metadata.library_archived && !state.offlineStorage?.conflicts.some(item=>item.id===id);
  const flush = () => flushDocument(runtime.persistence, runtime.document);
  const editor = useResearchEditor({
    document: runtime.document,
    provider: runtime.provider,
    user: { ...state.user!, color: "#3669d6" },
    editable: editable && !reading,
    canToggleTasks: editable,
  });
  const editorReady=useRef(onEditorReady);editorReady.current=onEditorReady;
  useEffect(()=>{if(!editor)return;const frame=requestAnimationFrame(()=>editorReady.current());return()=>cancelAnimationFrame(frame);},[editor]);
  useEffect(()=>{if(!editor)return;const capture=()=>({snapshot:editor.getJSON() as ExportSource["snapshot"],element:editor.view.dom});exportSource.current=capture;return()=>{if(exportSource.current===capture)exportSource.current=null;};},[editor,exportSource]);
  const historyContent=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(panel==='history')historyContent.current?.scrollTo({top:0});},[historyTab,panel]);
  useEffect(() => {
    if (!state.personal || !editor) return;
    let active=true;
    const updates=createDocumentUpdateCapture(runtime.document);
    const saver=deferredDocumentSave({delay:300,capture:()=>updates.capture(),isComposing:()=>editor.view.dom.dataset.composing==="true"||editor.view.composing,
      write:async value=>{await request(`documents/${id}/local-state`,"PUT",{ystate:value.ystate});updates.acknowledge(value);window.dispatchEvent(new Event("anote-note-changed"));},
      onPending:value=>{if(active)onLocalPending(value?1:0);},onError:error=>{if(active)setNotice(translateUI("本地保存失败：{0}", [(error as Error).message]));},
    });
    const save=()=>saver.flush(),capture=()=>saver.markDirty();
    saveRef.current = save;
    editor.on("update", capture);
    const remove = window.anote.onBeforeClose?.(async () => {
      if(editor.view.composing||editor.view.dom.dataset.composing==="true")throw new Error(translateUI("请先完成当前输入，再保存并关闭"));
      await flush();
      await save();
    });
    return () => {
      editor.off("update", capture);
      remove?.();
      active=false;saver.dispose();void save().catch(() => {}).finally(()=>{updates.dispose();if(saveRef.current===save)saveRef.current=null;});
    };
  }, [editor, id, state.personal]);
  async function addFiles(
    files: File[],
    position?: number,
    comparison = false,
    projection: "flat" | "equirectangular" = "flat",
  ) {
    if (
      !editor ||
      !editable ||
      reading ||
      state.offline ||
      !metadata.space_id ||
      transfer.current
    )
      return;
    const controller = new AbortController();
    transfer.current = controller;
    try {
      await uploadIntoEditor(
        editor,
        files,
        metadata.space_id,
        id,
        controller.signal,
        setUpload,
        position,
        comparison,
        projection,
      );
      setNotice(translateUI("附件已插入笔记。"));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      if (transfer.current === controller) {
        transfer.current = null;
        setUpload("");
      }
    }
  }
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const paste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length && editable && !reading && !state.offline) {
        e.preventDefault();
        void addFiles(files);
      }
    };
    const drop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length && editable && !reading && !state.offline) {
        e.preventDefault();
        const pos = editor.view.posAtCoords({
          left: e.clientX,
          top: e.clientY,
        })?.pos;
        void addFiles(files, pos);
      }
    };
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    dom.addEventListener("paste", paste, true);
    dom.addEventListener("drop", drop, true);
    dom.addEventListener("dragover", over);
    return () => {
      dom.removeEventListener("paste", paste, true);
      dom.removeEventListener("drop", drop, true);
      dom.removeEventListener("dragover", over);
    };
  }, [editor, editable, reading, state.offline, id]);
  useEffect(
    () => () => {
      transfer.current?.abort();
    },
    [id],
  );
  const local = state.sync.documents.find((d) => d.id === id),
    job = state.sync.pending.find((d) => d.docId === id);
  useEffect(() => {
    if(editor&&editor.isEditable!==(editable&&!reading))editor.setEditable(editable&&!reading);
  }, [editor, editable, reading]);
  async function refresh(target=panel) {
    if (state.offline) return;
    try {
      if(target==='comments')setComments(await request(`documents/${id}/comments`));
      if(target==='history'&&metadata.space_id)setVersions(await request(`documents/${id}/versions`));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  useEffect(() => {
    if(state.personal||state.offline||!interactionReady)return;
    let active=true;
    // Keep existing annotation markers available without polling every
    // document's comments or reading its version list during normal editing.
    void request(`documents/${id}/comments`).then(values=>{if(active)setComments(values);}).catch(()=>{});
    return()=>{active=false;};
  },[id,state.personal,state.offline,interactionReady]);
  useEffect(() => {
    if(!['comments','history'].includes(panel))return;
    let active=true;
    const refreshPanel=async()=>{
      if(state.offline)return;
      try{const values=await request(`documents/${id}/${panel==='comments'?'comments':'versions'}`);if(active)(panel==='comments'?setComments:setVersions)(values);}
      catch(error){if(active)setNotice((error as Error).message);}
    };
    void refreshPanel();
    const timer = setInterval(() => void refreshPanel(), 5000);
    return () => {active=false;clearInterval(timer);};
  }, [id, state.offline,panel]);
  useEffect(() => {
    if (!editor || !state.testing) return;
    window.__anoteTest = {
      editor,
      provider: runtime.provider,
      document: runtime.document,
      flush,
    };
    return () => {
      delete window.__anoteTest;
    };
  }, [editor, state.testing, runtime]);
  if (!editor) return null;
  async function checkout() {
    try {
      await window.anote.checkout({
        id,
        title: metadata.title || translateUI("笔记"),
      });
      setNotice(translateUI("笔记与附件已加入本地目录，后续修改会自动检查同步。"));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  async function addComment() {
    const anchor = commentAnchor || findAnchor(runtime.document, quote);
    if (!anchor) {
      setNotice(translateUI("请引用文档中存在的原文。"));
      return;
    }
    try {
      await request(`documents/${id}/comments`, "POST", { anchor, text });
      setText("");
      await refresh();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  async function restoreVersion() {
    try {
      const current = await request(`documents/${id}`);
      await request(`documents/${id}/versions/${preview.id}/restore`, "POST", {
        expectedHash: current.hash,
      });
      setPreview(null);
      setNotice(translateUI("已恢复此版本，恢复前的内容也已保留。"));
      await refresh();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-label={translateUI("上传附件文件")}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          const panoramaKind = uploadCategory.current === "panoramaImage" ? "image" : uploadCategory.current === "panoramaVideo" ? "video" : null;
          if (panoramaKind && files.some(file => file.type ? panoramaKind === "image" ? !["image/jpeg", "image/png", "image/webp"].includes(file.type) : !file.type.startsWith("video/") : !(panoramaKind === "image" ? /\.(jpe?g|png|webp)$/i : /\.(mp4|webm|mov|mkv)$/i).test(file.name))) {
            setNotice(panoramaKind === "image" ? translateUI("全景图片请选择 JPEG、PNG 或 WebP 文件。") : translateUI("全景视频请选择有效的视频文件。"));
            return;
          }
          if (
            uploadCategory.current === "comparison" &&
            (files.length !== 2 ||
              files.some((f) => !f.type.startsWith("image/")))
          ) {
            setNotice(translateUI("双图对比请选择恰好两张图片；更多图片请使用表格组织。"));
            return;
          }
          void addFiles(
            files,
            undefined,
            uploadCategory.current === "comparison",
            uploadCategory.current?.startsWith("panorama") ? "equirectangular" : "flat",
          );
        }}
      />
      {editable && !reading && (
        <EditorTools
          editor={editor}
          noteTargets={noteTargets}
          currentId={id}
          offline={state.offline || !!upload}
          onUpload={(category) => {
            uploadCategory.current = category;
            if (fileInput.current) {
              fileInput.current.accept = uploadTypes[category].accept;
              fileInput.current.click();
            }
          }}
          onComment={
            metadata.space_id && !state.personal
              ? () => {
                  setPanel("comments");
                  setCommentRequest((n) => n + 1);
                }
              : undefined
          }
        />
      )}
      {upload && (
        <div className="upload-status academic-upload-status" role="status">
          {upload}
          <button onClick={() => transfer.current?.abort()}>{translateUI("暂停上传")}</button>
        </div>
      )}
      {notice && (
        <div className="note-feedback" role="status">
          {notice}
          <button aria-label={translateUI("关闭提示")} onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      <div
        className={
          "editing-columns" +
          (panel === "comments" && metadata.space_id
            ? " has-annotations"
            : panel&&panel!=="history"
              ? " has-inspector"
              : "")
        }
      >
        {outlineOpen && (
          <NotePanelPortal target={floatingTarget}><DocumentOutline editor={editor} onClose={onCloseOutline} /></NotePanelPortal>
        )}
        <div className="paper">
          <ResearchEditorContent editor={editor} mentionActorId={state.user?.id} mentionCandidates={!state.personal&&!state.offline&&editable&&!reading?query=>request(`documents/${id}/mention-candidates?q=${encodeURIComponent(query)}`):undefined}/>
          <NoteReferences editor={editor} notes={noteTargets} currentId={id} onOpen={onOpenNoteLink}/>
        </div>
        {metadata.space_id && !state.personal && (
          <Annotations
            editor={editor}
            document={runtime.document}
            id={id}
            comments={comments}
            open={panel === "comments"}
            onOpen={() => setPanel("comments")}
            onClose={() => setPanel("")}
            canComment={role !== "viewer" && !metadata.archived&&!metadata.library_archived}
            offline={state.offline}
            onRefresh={refresh}
            commentRequest={commentRequest}
          />
        )}
        {panel && !(panel === "comments" && metadata.space_id) && (
          <NotePanelPortal target={panel==='history'?floatingTarget:null}><aside className={"inspector"+(panel==='history'?' floating-note-panel history-inspector':'')} aria-label={panel === "history" ? translateUI("历史版本") : panel === "sync" ? translateUI("本地同步") : translateUI("正文评论")}>
            <NotePanelHeader title={panel === "history" ? translateUI("历史版本") : panel === "sync" ? translateUI("本地同步") : translateUI("评论")} onClose={() => setPanel("")}/>
            {panel === "sync" ? (
              <div className="inspector-content">
                <span className="kicker">LOCAL WORKSPACE</span>
                <h3>{translateUI("笔记在手边")}</h3>
                <p>{translateUI("保留可编辑的 Markdown、原图附件和同步基准，连接到同一份研究文档。 ")}</p>
                <div className="local-status">
                  <span className="local-icon">▧</span>
                  <b>{local ? translateUI("已加入本地目录") : translateUI("尚未加入本地目录")}</b>
                  <small>
                    {local?.directory || translateUI("先在左侧选择本地工作目录")}
                  </small>
                </div>
                <button
                  className="primary wide"
                  disabled={
                    !state.workspace || !editable || state.offline || !!local
                  }
                  onClick={checkout}
                >{translateUI("↓ 下载到本地目录 ")}</button>
                {local && (
                  <button
                    className="wide"
                    disabled={state.offline}
                    onClick={async () => {
                      try {
                        await window.anote.sync(id);
                        setNotice(translateUI("已完成本轮同步检查。"));
                      } catch (e) {
                        setNotice((e as Error).message);
                      }
                    }}
                  >{translateUI("立即同步 ")}</button>
                )}
                <div className="sync-checks">
                  <p>{translateUI("✓ 结构化内容保真")}</p>
                  <p>{translateUI("✓ 本地修改三方合并")}</p>
                  <p>{translateUI("✓ 冲突保留双方内容")}</p>
                </div>
                {job && (
                  <div
                    className={
                      job.blocked ? "native-conflict" : "native-pending"
                    }
                    data-testid="local-job"
                  >
                    {job.blocked ? translateUI("需要处理冲突") : translateUI("等待同步")}
                    {job.error && <p>{job.error}</p>}
                    {job.blocked && (
                      <>
                        <p>{translateUI("可在本地编辑后重试。也可以保留本地副本，再采用线上版本。 ")}</p>
                        <button
                          disabled={state.offline}
                          onClick={async () => {
                            try {
                              const result =
                                await window.anote.acceptRemote(id);
                              setNotice(
                                translateUI("已采用线上版本，本地副本保存在 {0}", [result.backup]),
                              );
                            } catch (e) {
                              setNotice((e as Error).message);
                            }
                          }}
                        >{translateUI("保留本地副本，采用线上版本 ")}</button>
                      </>
                    )}
                  </div>
                )}
                {local?.result?.conflicts?.map((c: any, i: number) => (
                  <div className="native-conflict" key={i}>
                    <b>{c.blockId}</b>
                    <p>{c.reason}</p>
                    <details>
                      <summary>{translateUI("查看基准、线上与本地内容")}</summary>
                      {[
                        [translateUI("基准"), c.base],
                        [translateUI("线上"), c.remote],
                        [translateUI("本地"), c.local || c.localMarkdown],
                      ].map(([label, node]) => (
                        <div key={label as string}>
                          <strong>{label}</strong>
                          <pre>
                            {typeof node === "string"
                              ? node
                              : node
                                ? textOf(node) || JSON.stringify(node, null, 2)
                                : translateUI("此版本中不存在")}
                          </pre>
                        </div>
                      ))}
                    </details>
                  </div>
                ))}
              </div>
            ) : panel === "history" ? (
              <div ref={historyContent} className="inspector-content history-panel">
                <div className="home-tabs history-tabs" role="tablist" aria-label={translateUI("历史分类")}>
                  <button role="tab" aria-selected={historyTab==="automatic"} className={historyTab==="automatic"?"active":""} onClick={()=>setHistoryTab("automatic")}>{translateUI("自动记录")}</button>
                  <button role="tab" aria-selected={historyTab==="named"} className={historyTab==="named"?"active":""} onClick={()=>setHistoryTab("named")}>{translateUI("命名版本")}</button>
                </div>
                {editable && historyTab==="named" && (
                  <>
                    <label>{translateUI("版本号")}<input aria-label={translateUI("版本号")} maxLength={40} placeholder={translateUI("例如 v1.0")} value={versionName} onChange={event=>setVersionName(event.target.value)}/></label>
                    <input
                      aria-label={translateUI("版本说明")}
                      placeholder={translateUI("版本说明")}
                      maxLength={100}
                      value={versionLabel}
                      onChange={(event) => setVersionLabel(event.target.value)}
                    />
                    <button
                      disabled={state.offline || pending > 0 || !versionName.trim() || !versionLabel.trim()}
                      onClick={async () => {
                        try {
                          await request(`documents/${id}/versions`, "POST", {
                            label: versionLabel,
                            version_name:versionName.trim(),
                          });
                          setVersionLabel("");
                          setVersionName("");
                          setNotice(translateUI("当前版本已保留。"));
                          await refresh();
                        } catch (error) {
                          setNotice((error as Error).message);
                        }
                      }}
                    >{translateUI("保存当前版本 ")}</button>
                  </>
                )}
                {versions.filter(version=>Boolean(version.version_name||version.label?.trim())===(historyTab==="named")).map((version) => (
                  <article className={"history-entry "+(historyTab==="named"?"history-named":"history-row")} key={version.id} data-version-id={version.id}>
                    <b>
                      {version.version_name&&<span className="version-badge">{version.version_name}</span>}
                      {version.label ||
                        (
                          {
                            create: translateUI("创建文档"),
                            checkpoint: translateUI("手动保留"),
                            markdown: translateUI("本地同步"),
                            collaboration: translateUI("协同编辑"),
                            automatic: translateUI("自动留存"),
                            personal: translateUI("本地编辑"),
                            review: translateUI("历史快照"),
                            restore: translateUI("版本恢复"),
                            "before-restore": translateUI("恢复前保留"),
                            "before-markdown": translateUI("同步前保留"),
                            integration: translateUI("AI 工具编辑"),
                            "before-integration": translateUI("AI 编辑前保留"),
                          } as Record<string, string>
                        )[version.source] ||
                        translateUI("历史版本")}
                    </b>
                    <small title={new Date(version.created_at).toLocaleString(uiLocale())}>
                      {new Date(version.created_at).toLocaleString(uiLocale(),historyTab==="automatic"?{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}:undefined)}
                    </small>
                    <p className="history-editors" title={versionAttribution(version)}>{versionAttribution(version)}</p>
                    <button
                      onClick={async () => {
                        try {
                          setPreview(
                            await request(
                              `documents/${id}/versions/${version.id}`,
                            ),
                          );
                        } catch (error) {
                          setNotice((error as Error).message);
                        }
                      }}
                    >{translateUI("查看版本 ")}</button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="inspector-content">
                <div className="comment-targets">
                  <button
                    disabled={role === "viewer"}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const anchor = selectionAnchor(editor, runtime.document);
                      if (!anchor) {
                        setNotice(translateUI("请先在正文中选择要评论的文字。"));
                        return;
                      }
                      setCommentAnchor(anchor);
                      setQuote(anchor.quote);
                      setNotice(translateUI("已引用当前选区。"));
                    }}
                  >{translateUI("引用当前选区 ")}</button>
                  <button
                    disabled={role === "viewer"}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const node = editor.state.doc.child(
                          Math.min(
                            editor.state.selection.$from.index(0),
                            editor.state.doc.childCount - 1,
                          ),
                        ),
                        anchor = { blockId: node.attrs.blockId },
                        resolved = resolveAnchor(runtime.document, anchor);
                      if (!anchor.blockId || resolved.orphaned) {
                        setNotice(translateUI("当前内容块无法定位，请重新选择。"));
                        return;
                      }
                      setCommentAnchor({ ...anchor, quote: resolved.text });
                      setQuote(resolved.text);
                      setNotice(translateUI("已引用当前内容块。"));
                    }}
                  >{translateUI("评论当前段 ")}</button>
                </div>
                <textarea
                  rows={2}
                  aria-label={translateUI("评论原文")}
                  value={quote}
                  onChange={(e) => {
                    setQuote(e.target.value);
                    setCommentAnchor(null);
                  }}
                />
                <textarea
                  aria-label={translateUI("评论内容")}
                  placeholder={translateUI("记录观察、建议或问题…")}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <button
                  disabled={!text || state.offline || role === "viewer"}
                  onClick={addComment}
                >{translateUI("添加评论 ")}</button>
                {comments
                  .filter((c) => !c.parent_id)
                  .map((c) => (
                    <article key={c.id}>
                      <b>{c.author_name || c.author}</b>
                      <blockquote>
                        {c.resolvedAnchor.orphaned
                          ? translateUI("引用已删除，评论保留")
                          : c.resolvedAnchor.text}
                      </blockquote>
                      <p>{c.body}</p>
                      {comments
                        .filter((reply) => reply.parent_id === c.id)
                        .map((reply) => (
                          <div key={reply.id} className="thread-reply">
                            <b>{reply.author_name || reply.author}</b>
                            <p>{reply.body}</p>
                          </div>
                        ))}
                      {metadata.space_id && role !== "viewer" && (
                        <>
                          <input
                            aria-label={translateUI("回复 {0}", [c.id])}
                            placeholder={translateUI("回复这条评论…")}
                            value={reply[c.id] || ""}
                            onChange={(event) =>
                              setReply({ ...reply, [c.id]: event.target.value })
                            }
                          />
                          <button
                            disabled={state.offline || !reply[c.id]}
                            onClick={async () => {
                              try {
                                await request(
                                  `documents/${id}/comments`,
                                  "POST",
                                  { parent_id: c.id, text: reply[c.id] },
                                );
                                setReply({ ...reply, [c.id]: "" });
                                await refresh();
                              } catch (error) {
                                setNotice((error as Error).message);
                              }
                            }}
                          >{translateUI("回复 ")}</button>
                          <button
                            disabled={state.offline}
                            onClick={async () => {
                              try {
                                await request(
                                  `documents/${id}/comments/${c.id}`,
                                  "PATCH",
                                  { resolved: !c.resolved },
                                );
                                await refresh();
                              } catch (error) {
                                setNotice((error as Error).message);
                              }
                            }}
                          >
                            {c.resolved ? translateUI("重新打开") : translateUI("解决评论")}
                          </button>
                        </>
                      )}
                    </article>
                  ))}
              </div>
            )}
          </aside></NotePanelPortal>
        )}
      </div>
      {preview && (
        <SnapshotPreview
          version={preview}
          user={state.user!}
          canRestore={editable && !state.offline && pending === 0}
          onClose={() => setPreview(null)}
          onRestore={restoreVersion}
        />
      )}
    </>
  );
}

function versionAttribution(version: any) {
  const attribution=version.editors?.length
    ? translateUI("编辑者：{0}", [version.editors.map((person: { name: string }) => person.name).join("、")])
    : version.author_name
      ? translateUI("记录者：{0}", [version.author_name])
      : translateUI("编辑者未记录");
  return attribution+(version.integration_client?translateUI(" · 经 {0}", [version.integration_client]):"");
}

function SnapshotPreview({
  version,
  user,
  canRestore,
  onClose,
  onRestore,
}: {
  version: any;
  user: { id: string; name: string };
  canRestore: boolean;
  onClose: () => void;
  onRestore: () => void;
}) {
  const document = useMemo(
    () => prosemirrorJSONToYDoc(schema, version.snapshot, "default"),
    [version.id],
  );
  const editor = useResearchEditor({ document, user, editable: false });
  const dialog = useDialog<HTMLDivElement>(onClose);
  useEffect(() => () => document.destroy(), [document]);
  return (
    <div ref={dialog} className="modal" role="dialog" aria-label={translateUI("历史版本预览")}>
      <section className="snapshot-modal">
        <div className="snapshot-header">
          <div>
            <h3>{[version.version_name,version.label].filter(Boolean).join(" · ") || translateUI("历史版本")}</h3>
            <small>
              {new Date(version.created_at).toLocaleString(uiLocale())}
            </small>
            <p className="history-editors">{versionAttribution(version)}</p>
          </div>
          <DialogClose onClick={onClose} label={translateUI("关闭预览")}/>
        </div>
        <div className="snapshot-content">
          <ResearchEditorContent editor={editor} />
        </div>
        <div className="snapshot-actions">
          <span>{translateUI("恢复前会保留当前内容，可再次找回。")}</span>
          <button
            className="primary"
            disabled={!canRestore}
            onClick={onRestore}
          >{translateUI("恢复此版本 ")}</button>
        </div>
      </section>
    </div>
  );
}

import { t as translateUI } from "@anote/i18n";
import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {ResearchEditorContent,useResearchEditor} from '@anote/editor';
import {request,type NativeState} from './native';
import {Icon} from './icons';
import {usePageWidth} from './document-width';
import {NoteReferences,type NoteLinkTarget} from './note-links';
import {readDocumentPreview,forgetDocumentPreview,type DocumentPreviewCache} from './document-preview-cache';
import {prepareDocumentDatabase} from './document-preview-repair';
import {DocumentLoading} from './document-loading';
import './document-loading.css';
import {useDocumentChrome} from './document-layout';

export type LivePreviewGate={visible:boolean;initialStateEncoding?:number;onEditorReady:(section:HTMLElement|null)=>void;onDenied:(message:string)=>void};
type Props={state:NativeState;id:string;title:string;headerControls?:React.ReactNode;headerActions?:React.ReactNode;onBack?:()=>void;onNotes?:()=>void;notesOpen?:boolean;compact?:boolean;noteTargets?:NoteLinkTarget[];onOpenNoteLink?:(id:string)=>void;renderLive:(gate:LivePreviewGate)=>React.ReactNode};
function SnapshotBody({snapshot,onPaint,notes,id,onOpen}:{snapshot:any;onPaint:()=>void;notes:NoteLinkTarget[];id:string;onOpen?:(id:string)=>void}){
  // This is a disposable display document. It never receives a provider and
  // is never merged or written back into the authoritative collaboration Doc.
  const document=useMemo(()=>prosemirrorJSONToYDoc(schema,snapshot,'default'),[snapshot]);useEffect(()=>()=>document.destroy(),[document]);
  const editor=useResearchEditor({document,user:{id:'preview',name:translateUI("正文预览")},editable:false,canToggleTasks:false});
  useLayoutEffect(()=>{if(!editor)return;editor.view.dom.dataset.testid='document-preview-body';editor.view.dom.setAttribute('aria-label',translateUI("笔记正文预览"));editor.view.dom.setAttribute('aria-readonly','true');},[editor]);
  useEffect(()=>{if(!editor)return;let next=0;const first=requestAnimationFrame(()=>{next=requestAnimationFrame(onPaint);});return()=>{cancelAnimationFrame(first);cancelAnimationFrame(next);};},[editor,onPaint]);
  return <div className="editing-columns"><div className="paper"><ResearchEditorContent editor={editor}/><NoteReferences editor={editor} notes={notes} currentId={id} onOpen={onOpen}/></div></div>;
}

/** Permission/preview loading is intentionally outside LiveDocument. The
 * latter constructs IndexeddbPersistence, whose first restore can decode all
 * historical updates; even constructing that runtime before this first frame
 * would put the old blocking work back on the preview's critical path. */
export function DocumentPreviewGate({state,id,title,headerControls,headerActions,onBack,onNotes,notesOpen,compact,noteTargets=[],onOpenNoteLink,renderLive}:Props){
  const [preview,setPreview]=useState<any>(null),[problem,setProblem]=useState(''),[preparing,setPreparing]=useState(false),[hydrating,setHydrating]=useState(false),[visible,setVisible]=useState(false),[denied,setDenied]=useState(false),[previewPainted,setPreviewPainted]=useState(false),[localUnconfirmed,setLocalUnconfirmed]=useState(false),[legacyDraft,setLegacyDraft]=useState(false),[stateEncoding,setStateEncoding]=useState<number|undefined>();
  const region=useRef<HTMLElement>(null),scroll=useRef(0),liveSection=useRef<HTMLElement|null>(null),started=useRef(false);const [pageWidth]=usePageWidth(state.serverURL,state.user!.id);
  useDocumentChrome(region,!!preview);
  const start=useCallback(()=>{if(started.current)return;started.current=true;setPreparing(true);},[]);
  const onPreviewPaint=useCallback(()=>{setPreviewPainted(true);start();},[start]);
  const onEditorReady=useCallback((section:HTMLElement|null)=>{scroll.current=region.current?.scrollTop||0;liveSection.current=section;setVisible(true);},[]);
  const onDenied=useCallback((message:string)=>{setDenied(true);setVisible(false);setPreview(null);setProblem(message||translateUI("笔记不存在或阅读权限已变化"));void forgetDocumentPreview(state,id).catch(()=>{});},[id,state.serverURL,state.user?.id,state.workspace]);
  useEffect(()=>{
    if(started.current)return;let current=true,first=0,second=0;
    const fallbackStart=()=>{first=requestAnimationFrame(()=>{second=requestAnimationFrame(start);});};
    const fetchPreview=async()=>{
      try{return await request(`documents/${id}/preview`);}
      catch(error){if((error as any).status!==404)throw error;
        // 0.5.3 servers do not have /preview. A missing route is not proof the
        // note disappeared: reauthorize through their metadata endpoint.
        return request(`documents/${id}?content=metadata${state.desktop===true?'&access_check=1':''}`);
      }
    };
    void Promise.allSettled([fetchPreview(),readDocumentPreview(state,id)]).then(results=>{
      if(!current)return;const remote=results[0],cache:DocumentPreviewCache=results[1].status==='fulfilled'?results[1].value:{hasUpdates:true,value:null};
      if(remote.status==='rejected'){
        const error=remote.reason;if([401,403,404].includes(error?.status)){onDenied(error.message);return;}
        if(cache.value){setPreview({...cache.value.metadata,snapshot:cache.value.snapshot});setLocalUnconfirmed(true);}else{setProblem(error?.message||translateUI("正在连接服务器"));fallbackStart();}return;
      }
      const value=remote.value;setStateEncoding(value.state_encoding===2?2:1);
      if(cache.value?.pendingLocal){
        setPreview({...cache.value.metadata,...value,snapshot:cache.value.snapshot});setLocalUnconfirmed(true);
      }else if(cache.hasUpdates&&!cache.value){
        // An older installation or a crash can leave IndexedDB changes newer
        // than either the server or the desktop's deferred native mirror.
        // Restore that draft before showing a body without a trusted cursor.
        setPreview(null);setLegacyDraft(true);
      }else if(value.snapshot){setPreview(value);setLocalUnconfirmed(value.preview_source==='local-draft');}
      else if(cache.value){setPreview({...cache.value.metadata,...value,snapshot:cache.value.snapshot});setLocalUnconfirmed(cache.value.pendingLocal);}
      else setLegacyDraft(cache.hasUpdates);
      if(cache.hasUpdates&&!cache.value||!value.snapshot&&!cache.value)fallbackStart();
    });
    return()=>{current=false;cancelAnimationFrame(first);cancelAnimationFrame(second);};
  },[id,state.serverURL,state.user?.id,state.token,state.workspace,state.offline,start,onDenied]);
  useEffect(()=>{
    if(!preparing||denied)return;const controller=new AbortController();let active=true;
    // The worker alone reads/decodes a legacy IndexedDB update. Its compact
    // checkpoint preserves CRDT identities and every pending local update.
    void prepareDocumentDatabase(state,id,stateEncoding,controller.signal).catch(()=>{}).finally(()=>{if(active)setHydrating(true);});
    return()=>{active=false;controller.abort();};
  },[preparing,denied,id,stateEncoding,state.serverURL,state.user?.id]);
  useLayoutEffect(()=>{if(visible&&liveSection.current)liveSection.current.scrollTop=scroll.current;},[visible]);
  useEffect(()=>{
    const element=region.current;if(!element)return;const open=(event:Event)=>{const target=(event as CustomEvent).detail?.id;if(typeof target==='string'&&/^[-\w]{1,80}$/.test(target)&&onOpenNoteLink){event.preventDefault();onOpenNoteLink(target);}};element.addEventListener('anote-open-note',open);return()=>element.removeEventListener('anote-open-note',open);
  },[preview,onOpenNoteLink]);
  useEffect(()=>{if(visible)return;const save=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopImmediatePropagation();}};window.addEventListener('keydown',save,true);return()=>window.removeEventListener('keydown',save,true);},[visible]);
  return <>
    {!visible&&<section ref={region} className="document-region" data-page-width={pageWidth} data-mobile-reading={compact?'read':undefined} data-view-ready={previewPainted&&!!preview} data-edit-ready="false" data-sync-ready="false" data-testid="document-preview">
      <div className="document-header academic-document-header">{headerControls}{onNotes&&<button className="mobile-note-list-trigger" aria-label={translateUI("显示笔记列表")} aria-expanded={notesOpen} onClick={onNotes}><Icon name="list" size={19}/></button>}{onBack&&<button className="document-back" aria-label={translateUI("返回知识库")} onClick={onBack}><Icon name="back"/></button>}<div className="document-title-wrap"><span className="note-title">{preview?.title||title}</span></div><div className="workspace-header-actions">{headerActions}</div></div>
      <DocumentLoading requestKey={id} pending={!previewPainted&&!denied} error={preview?'':problem} message={legacyDraft?translateUI("正在恢复这台设备保存的内容"):translateUI("正在读取笔记")} overlay={!!preview}/>
      {preview&&<><div className="document-info" role="status">{localUnconfirmed?translateUI("本机内容已显示，正在核对同步状态…"):translateUI("正文已显示，正在准备编辑…")}</div><SnapshotBody snapshot={preview.snapshot} onPaint={onPreviewPaint} notes={noteTargets} id={id} onOpen={onOpenNoteLink}/></>}
    </section>}
    {hydrating&&!denied&&renderLive({visible,initialStateEncoding:stateEncoding,onEditorReady,onDenied})}
  </>;
}

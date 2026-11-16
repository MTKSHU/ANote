import { t as translateUI } from "@anote/i18n";
import {useEffect} from 'react';
import * as Y from 'yjs';
import {IndexeddbPersistence} from 'y-indexeddb';
import {HocuspocusProvider,HocuspocusProviderWebsocket} from '@hocuspocus/provider';
import {EDITOR_SCHEMA_VERSION,schema} from '@anote/document-model';
import {initProseMirrorDoc} from '@tiptap/y-tiptap';
import type {NativeState} from './native';
import {cacheMetadata,createDocumentUpdateCapture,deferredDocumentSave} from './document-save';
import {flushDocumentUpdates} from './persistence';
import {registerReloadGuard} from './reload-guards';
import {DocumentSessionCache,type SessionResource} from './document-session-cache';
import {trackDocumentPersistence} from './document-cache-persistence';
import {writeDocumentPreview} from './document-preview-cache';
import {acknowledgeDocumentRepair} from './document-preview-repair';
import {applyDocumentMigrationEncoding,DOCUMENT_PROTOCOL_ORIGIN} from './document-migration-protocol';

type Listener={status:(status:string)=>void;synced:()=>void;pending:(count:number)=>void;failed:(reason:string)=>void;saveError:(error:unknown)=>void};
function createSession(state:NativeState,id:string,encoding?:number){
  const document=new Y.Doc();
  const persistence=new IndexeddbPersistence(`anote:${state.serverURL}:${state.user!.id}:${id}`,document),listeners=new Set<Listener>();
  const persistenceUpdates=trackDocumentPersistence(document,persistence);
  let bytes=0,localRevision=0,savedLocalRevision=0,savedMetadata='',context:{metadata:any;ready:boolean}={metadata:null,ready:false},composition:(()=>boolean)|null=null,indexRevision=0,durableIndexRevision=0,pending=0,saveError:unknown=null,transportDestroyed=false,acknowledged=false,hydrationComplete=false,desiredEncoding=encoding;
  const updates=state.desktop===true&&window.anote?.cacheOfflineDocument?createDocumentUpdateCapture(document):undefined;
  const saver=updates?deferredDocumentSave({
    canSave:()=>context.ready&&!!context.metadata&&!context.metadata.archived&&!context.metadata.library_archived&&['admin','editor'].includes(context.metadata.role||state.user?.role),
    isComposing:()=>!!composition?.(),
    capture:()=>({batch:updates.capture(),revision:localRevision,metadata:cacheMetadata(context.metadata)}),
    write:async value=>{await window.anote.cacheOfflineDocument!({id,ystate:value.batch.ystate,metadata:value.metadata,local:value.revision>savedLocalRevision,serverURL:state.serverURL,userId:state.user!.id});updates.acknowledge(value.batch);savedLocalRevision=Math.max(savedLocalRevision,value.revision);savedMetadata=JSON.stringify(value.metadata);saveError=null;},
    onError:error=>{saveError=error;for(const listener of listeners)listener.saveError(error);},
  }):undefined;
  const socket=new HocuspocusProviderWebsocket({url:state.serverURL.replace(/^http/,'ws')+'/collab',autoConnect:false});
  const confirm=()=>{acknowledged=true;void acknowledgeDocumentRepair(persistence).catch(()=>{});};
  const provider:HocuspocusProvider=new HocuspocusProvider({websocketProvider:socket,name:id,document,token:state.validationMode?state.token||'':JSON.stringify({token:state.token||'',schema:EDITOR_SCHEMA_VERSION,migrationEncoding:2}),
    onStatus:({status})=>{for(const listener of listeners)listener.status(status);},
    onSynced:({state:ready})=>{if(ready){if(!provider.hasUnsyncedChanges)confirm();for(const listener of listeners)listener.synced();}},
    onUnsyncedChanges:({number})=>{pending=number;if(number>0)acknowledged=false;else if(provider.isSynced)confirm();for(const listener of listeners)listener.pending(number);},
    onAuthenticationFailed:({reason})=>{acknowledged=false;context={metadata:null,ready:false};for(const listener of listeners)listener.failed(reason);},
  });provider.attach();
  const changed=(update:Uint8Array,origin:unknown,_document:Y.Doc,transaction:Y.Transaction)=>{bytes+=update.byteLength;indexRevision++;if(transaction.local&&origin!==DOCUMENT_PROTOCOL_ORIGIN)localRevision++;saver?.markDirty();};document.on('update',changed);
  // Restoring the existing marker first makes an unchanged reopen idempotent.
  // Writing marker2 into an empty Doc would create a fresh concurrent client
  // struct on every JS session, even when the note was never edited.
  const ready=persistence.whenSynced.then(()=>{hydrationComplete=true;applyDocumentMigrationEncoding(document,desiredEncoding);});
  const value={document,persistence,provider,socket,hydrated:{ystate:'',hash:''},
    subscribe(listener:Listener){listeners.add(listener);listener.pending(pending);listener.status(socket.status);if(saveError)listener.saveError(saveError);return()=>{listeners.delete(listener);};},
    begin(){context={metadata:null,ready:false};if(provider.awareness?.getLocalState()===null)provider.awareness.setLocalState({});},
    authorize(metadata:any,ready:boolean){if(metadata?.state_encoding===2)desiredEncoding=2;if(hydrationComplete)applyDocumentMigrationEncoding(document,desiredEncoding);context={metadata,ready};if(ready&&metadata&&(updates?.pending||JSON.stringify(cacheMetadata(metadata))!==savedMetadata))saver?.markDirty();},
    composing(guard:(()=>boolean)|null){composition=guard;},
    saveNative:()=>saver?.flush()||Promise.resolve(),
    savePreview:()=>checkpointPreview(),
  };
  const checkpointPreview=async()=>{
    if(!context.ready||!context.metadata)return;
    // Capture only at explicit durability barriers, never on each input.
    // _dbref covers every IndexedDB update incorporated by this live session.
    await persistenceUpdates.refresh();
    const snapshot=initProseMirrorDoc(document.getXmlFragment('default'),schema).doc.toJSON();
    await writeDocumentPreview(persistence,state,id,context.metadata,snapshot,!acknowledged||provider.hasUnsyncedChanges);
  };
  const checkpointIndex=async()=>{const through=indexRevision;await flushDocumentUpdates(persistence);durableIndexRevision=Math.max(durableIndexRevision,through);};
  const destroyTransport=()=>{if(transportDestroyed)return;transportDestroyed=true;provider.destroy();socket.destroy();};
  const checkpoint=async()=>{
    if(composition?.())throw new Error(translateUI("请先完成当前输入，再保存并关闭"));
    const results=await Promise.allSettled([saver?.flush(),checkpointPreview().then(checkpointIndex)]);
    const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason;
  };
  const resource:SessionResource<typeof value>={value,ready,
    refresh:async()=>{await ready;await persistenceUpdates.refresh();applyDocumentMigrationEncoding(document,desiredEncoding);},
    flush:checkpoint,
    deactivate:()=>{composition=null;provider.awareness?.setLocalState(null);socket.disconnect();},
    bytes:()=>bytes,
    canEvict:()=>durableIndexRevision===indexRevision&&(!saver||localRevision===savedLocalRevision),
    usable:()=>!document.isDestroyed&&!transportDestroyed,
    dispose:async()=>{destroyTransport();await checkpoint();saver?.dispose();updates?.dispose();persistenceUpdates.dispose();document.off('update',changed);await persistence.destroy();document.destroy();listeners.clear();},
    forget:async()=>{destroyTransport();saver?.dispose();await saver?.settled().catch(()=>{});await checkpointIndex();updates?.dispose();persistenceUpdates.dispose();document.off('update',changed);await persistence.destroy();document.destroy();listeners.clear();},
  };
  return resource;
}
export type DocumentSession=ReturnType<typeof createSession>['value'];
const sessions=new DocumentSessionCache<DocumentSession>();
export function documentSessionOwner(state:NativeState){return JSON.stringify([state.serverURL,state.user?.id,state.token,!!state.personal,state.workspace]);}
export function acquireDocumentSession(state:NativeState,id:string,encoding?:number){const owner=documentSessionOwner(state);return sessions.acquire(owner,owner+'|'+id,()=>createSession(state,id,encoding));}
export function useDocumentSessionScope(state:NativeState){
  const owner=documentSessionOwner(state);
  useEffect(()=>{
    sessions.useOwner(owner);
    const flush=()=>sessions.flush(owner),removeReload=registerReloadGuard(flush),removeClose=window.anote?.onBeforeClose?.(flush);
    return()=>{removeReload();removeClose?.();sessions.clearOwner(owner);};
  },[owner]);
  return owner;
}

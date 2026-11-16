import * as Y from "yjs";

/** Encode only after typing has settled, without allocating one string per byte. */
export function encodeDocumentUpdate(bytes:Uint8Array) {
  let binary="";
  for(let offset=0;offset<bytes.length;offset+=16384)binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
  return btoa(binary);
}

export function encodeDocumentState(document:Y.Doc) {
  return encodeDocumentUpdate(Y.encodeStateAsUpdate(document));
}

/** Capture one recoverable baseline, then only new CRDT updates. Long-lived
 * documents can contain far more history than visible text. Re-encoding that
 * complete history after every input pause blocks the renderer and IPC.
 * Keep batches until their durable write succeeds, including writes in flight.
 */
export function createDocumentUpdateCapture(document:Y.Doc) {
  const baselineFromUpdates=Y.encodeStateVector(document).length===1&&!document.store.pendingStructs&&!document.store.pendingDs;
  let baseline=true,sequence=0,updates:{sequence:number;bytes:Uint8Array}[]=[];
  const changed=(bytes:Uint8Array)=>updates.push({sequence:++sequence,bytes});
  document.on("update",changed);
  return {
    get pending(){return baseline||updates.length>0;},
    capture(){
      const through=sequence,isBaseline=baseline;
      const bytes=isBaseline&&!baselineFromUpdates?Y.encodeStateAsUpdate(document):updates.length===1?updates[0].bytes:updates.length?Y.mergeUpdates(updates.map(update=>update.bytes)):new Uint8Array([0,0]);
      return {ystate:encodeDocumentUpdate(bytes),through,isBaseline};
    },
    acknowledge(batch:{through:number;isBaseline:boolean}){
      if(batch.isBaseline)baseline=false;
      updates=updates.filter(update=>update.sequence>batch.through);
    },
    dispose(){document.off("update",changed);},
  };
}

export function cacheMetadata(value:Record<string,unknown>) {
  const {ystate:_ystate,snapshot:_snapshot,assets:_assets,...metadata}=value;
  return metadata;
}

/** Keep rapid update/ACK cycles from re-rendering the document header each time.
 * This indicator never participates in provider counters or actual sync waits.
 */
export function createSyncPendingIndicator(onChange:(value:0|1)=>void,delay=120) {
  let displayed:0|1=0,pending=false,disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{clearTimeout(timer);timer=undefined;};
  return {
    update(count:number){
      if(disposed)return;
      pending=count>0;
      if(pending){clear();if(displayed===0){displayed=1;onChange(1);}return;}
      if(displayed===0||timer!==undefined)return;
      timer=setTimeout(()=>{timer=undefined;if(!disposed&&!pending&&displayed===1){displayed=0;onChange(0);}},delay);
    },
    dispose(){disposed=true;clear();},
  };
}

/** One writer; updates during I/O coalesce and explicit flush drains the newest revision. */
export function deferredDocumentSave<T>({capture,write,canSave=()=>true,isComposing=()=>false,onPending=()=>{},onError=()=>{},delay=350}:{capture:()=>T;write:(value:T)=>Promise<void>;canSave?:()=>boolean;isComposing?:()=>boolean;onPending?:(pending:boolean)=>void;onError?:(error:unknown)=>void;delay?:number}) {
  let revision=0,saved=0,running:Promise<void>|null=null,timer:ReturnType<typeof setTimeout>|undefined,disposed=false,failed=false;
  const clear=()=>{clearTimeout(timer);timer=undefined;};
  const schedule=()=>{clear();if(disposed||failed||revision===saved)return;timer=setTimeout(()=>{if(isComposing()){schedule();return;}void run().catch(()=>{});},delay);};
  function run():Promise<void>{
    clear();if(running)return running;if(revision===saved||!canSave())return Promise.resolve();
    const capturedRevision=revision;let payload:T;
    try{payload=capture();}catch(error){failed=true;onError(error);return Promise.reject(error);}
    const task=Promise.resolve().then(()=>write(payload)).then(()=>{saved=capturedRevision;failed=false;onPending(saved<revision);}).catch(error=>{failed=true;onError(error);throw error;}).finally(()=>{if(running===task)running=null;if(!failed)schedule();});
    running=task;return task;
  }
  return {
    markDirty(){revision++;failed=false;onPending(true);schedule();},
    async flush(){clear();while(revision>saved){if(!canSave())return;await(run());clear();}},
    settled(){return running||Promise.resolve();},
    dispose(){disposed=true;clear();},
  };
}

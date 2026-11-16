type Work<T>=(signal:AbortSignal)=>Promise<T>;
type Entry={bytes:number;work:Work<unknown>;controller:AbortController;failure?:Error;resolve:(value:unknown)=>void;reject:(error:unknown)=>void;timer?:ReturnType<typeof setTimeout>;detach:()=>void};

/** One large document worker at a time. Admission happens before callers copy
 * their input, so rejected jobs do not allocate another large state buffer.
 * Active cancellation keeps its slot until the worker has actually exited. */
export class DocumentWorkerQueue{
  private active?:Entry;
  private pending:Entry[]=[];
  private pendingBytes=0;
  constructor(private readonly options={maxQueued:16,maxQueuedBytes:Number.MAX_SAFE_INTEGER,timeoutMs:30000},private readonly label='文档后台处理'){}
  run<T>(factory:()=>Work<T>,{bytes,signal}:{bytes:number;signal?:AbortSignal}):Promise<T>{
    if(signal?.aborted)return Promise.reject(new Error(this.label+'已中止，原件保持不变'));
    if(!Number.isSafeInteger(bytes)||bytes<0)return Promise.reject(new Error(this.label+'大小无效，原件保持不变'));
    if(this.active&&(this.pending.length>=this.options.maxQueued||this.pendingBytes+bytes>this.options.maxQueuedBytes))return Promise.reject(new Error(this.label+'任务较多，请稍后重试；原件保持不变'));
    let work:Work<T>;try{work=factory();}catch(error){return Promise.reject(error);}
    return new Promise<T>((resolve,reject)=>{
      const entry:Entry={bytes,work,controller:new AbortController(),resolve:value=>resolve(value as T),reject,detach:()=>{}};
      const aborted=()=>this.cancel(entry,new Error(this.label+'已中止，原件保持不变'));
      entry.detach=()=>signal?.removeEventListener('abort',aborted);
      entry.timer=setTimeout(()=>this.cancel(entry,new Error(this.label+'超时，请稍后重试；原件保持不变')),this.options.timeoutMs);
      if(this.active){this.pending.push(entry);this.pendingBytes+=bytes;}else this.start(entry);
      signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
    });
  }
  private cancel(entry:Entry,error:Error){
    if(entry.failure)return;entry.failure=error;entry.controller.abort(error);
    if(this.active===entry)return;
    const index=this.pending.indexOf(entry);if(index<0)return;
    this.pending.splice(index,1);this.pendingBytes-=entry.bytes;this.clean(entry);entry.reject(error);
  }
  private clean(entry:Entry){clearTimeout(entry.timer);entry.detach();}
  private start(entry:Entry){
    this.active=entry;
    Promise.resolve().then(()=>{entry.controller.signal.throwIfAborted();return entry.work(entry.controller.signal);}).then(value=>this.finish(entry,value),error=>this.finish(entry,undefined,error,true));
  }
  private finish(entry:Entry,value:unknown,error?:unknown,failed=false){
    this.clean(entry);this.active=undefined;
    if(entry.failure||failed)entry.reject(entry.failure||error);else entry.resolve(value);
    const next=this.pending.shift();if(next){this.pendingBytes-=next.bytes;this.start(next);}
  }
}

const sharedDocumentWorkers=new DocumentWorkerQueue();
/** The operation must settle only after its worker exits, including aborts.
 * Zero-argument operations are supported; operations that accept the signal
 * can terminate their worker promptly when the shared deadline expires. */
export function withDocumentWorker<T>(operation:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  return sharedDocumentWorkers.run(()=>operation,{bytes:0,signal});
}

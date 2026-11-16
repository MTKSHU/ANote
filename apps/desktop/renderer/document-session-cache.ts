import { t as translateUI } from "@anote/i18n";
export type SessionResource<T>={
  value:T;
  ready:Promise<unknown>;
  refresh:()=>Promise<unknown>;
  flush:()=>Promise<unknown>;
  deactivate:()=>void;
  dispose:()=>Promise<unknown>;
  forget?:()=>Promise<unknown>;
  bytes:()=>number;
  canEvict:()=>boolean;
  usable:()=>boolean;
};
type Entry<T>={owner:string;key:string;resource:SessionResource<T>;refs:number;load:Promise<unknown>;tail:Promise<unknown>;idleAt:number;timer?:ReturnType<typeof setTimeout>;invalid:boolean;forget:boolean;disposing:boolean};

/** Only inactive, durably saved documents count as eviction candidates. A
 * failed save stays recoverable and is retried by flush before leaving the
 * account. Limits count encoded update bytes, not JavaScript heap bytes. */
export class DocumentSessionCache<T>{
  private owner="";
  private entries=new Map<string,Entry<T>>();
  private live=new Set<Entry<T>>();
  constructor(private options={idleEntries:2,idleBytes:32*1024*1024,ttl:15*60*1000,now:()=>Date.now()}){}
  useOwner(owner:string){if(this.owner===owner)return;this.owner=owner;for(const entry of this.live)if(entry.owner!==owner)this.invalidate(entry,true);}
  clearOwner(owner:string){if(this.owner===owner)this.owner="";for(const entry of this.live)if(entry.owner===owner)this.invalidate(entry,true);}
  private invalidate(entry:Entry<T>,forget=false){entry.invalid=true;entry.forget ||= forget;if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key);if(!entry.refs)this.retire(entry);}
  private retire(entry:Entry<T>){
    if(entry.refs||entry.disposing)return;
    entry.disposing=true;clearTimeout(entry.timer);
    void entry.tail.then(async()=>{
      if(entry.refs){entry.disposing=false;return;}
      try{
        if(entry.forget&&entry.resource.forget){await entry.resource.forget();this.live.delete(entry);return;}
        await entry.resource.flush();
        if(!entry.resource.canEvict()){entry.disposing=false;this.expire(entry);return;}
        await entry.resource.dispose();this.live.delete(entry);
      }
      catch{entry.disposing=false;this.expire(entry);}
    });
  }
  private expire(entry:Entry<T>){
    clearTimeout(entry.timer);if(entry.refs)return;
    entry.timer=setTimeout(()=>{entry.timer=undefined;this.sweep();if(this.live.has(entry)&&!entry.refs)this.expire(entry);},this.options.ttl);
    (entry.timer as any).unref?.();
  }
  acquire(owner:string,key:string,create:()=>SessionResource<T>){
    this.useOwner(owner);
    let entry=this.entries.get(key),reused=!!entry;
    if(entry&&!entry.resource.usable()){this.invalidate(entry);entry=undefined;reused=false;}
    if(!entry){const resource=create(),load=Promise.resolve(resource.ready).catch(()=>{});entry={owner,key,resource,refs:0,load,tail:load,idleAt:this.options.now(),invalid:false,forget:false,disposing:false};this.entries.set(key,entry);this.live.add(entry);this.expire(entry);}
    const current=entry;
    // The shared live document is already authoritative while its mirror is
    // writing. Reopening waits for IndexedDB refresh, not an unrelated worker
    // fsync. tail still tracks every save for eviction/account/close barriers.
    const ready=reused?current.load.then(()=>current.resource.refresh()):Promise.resolve(current.resource.ready);
    current.load=ready.catch(()=>{});
    current.tail=Promise.all([current.tail,current.load]);
    void ready.catch(()=>this.invalidate(current,true));
    // Render-only acquisitions must not pin a document if React abandons the
    // render before its effect can attach and eventually release the lease.
    void ready.then(()=>{if(!current.refs&&!current.invalid){const task=current.tail.then(()=>current.resource.flush());current.tail=task.catch(()=>{});}},()=>{});
    let active=false,released=false;
    return {value:current.resource.value,ready,reused,
      activate:()=>{if(released||current.invalid)throw new Error(translateUI("笔记会话已失效，请重新打开"));if(active)return;active=true;current.refs++;clearTimeout(current.timer);},
      invalidate:()=>this.invalidate(current,true),
      release:()=>{
        if(released)return;released=true;
        if(active){active=false;current.refs--;}
        if(current.refs)return;
        current.resource.deactivate();
        const checkpoint=current.tail.then(()=>current.resource.flush());
        current.tail=checkpoint.catch(()=>{});
        void current.tail.then(()=>{current.idleAt=this.options.now();if(current.invalid)this.retire(current);else{this.expire(current);this.sweep();}});
      },
    };
  }
  sweep(){
    const idle=[...this.entries.values()].filter(entry=>!entry.refs&&!entry.disposing).sort((a,b)=>a.idleAt-b.idleAt);
    let count=idle.length,bytes=idle.reduce((sum,entry)=>sum+entry.resource.bytes(),0);
    for(const entry of idle){
      if(!entry.resource.canEvict())continue;
      if(this.options.now()-entry.idleAt<this.options.ttl&&count<=this.options.idleEntries&&bytes<=this.options.idleBytes)continue;
      count--;bytes-=entry.resource.bytes();this.invalidate(entry);
    }
  }
  async flush(owner:string){
    await Promise.all([...this.live].filter(entry=>entry.owner===owner).map(async entry=>{await entry.tail;await entry.resource.flush();if(entry.invalid&&!entry.refs)this.retire(entry);}));this.sweep();
  }
  stats(){return {retained:this.entries.size,live:this.live.size,active:[...this.live].filter(entry=>entry.refs>0).length};}
}

type Waiter={exclusive:boolean;resolve:(release:()=>void)=>void};
type Gate={active:number;exclusive:boolean;queue:Waiter[]};
const gates=new Map<string,Gate>();

function acquire(id:string,exclusive:boolean):Promise<()=>void>{
  let gate=gates.get(id);if(!gate){gate={active:0,exclusive:false,queue:[]};gates.set(id,gate);}
  const current=gate;
  const drain=()=>{
    if(current.exclusive)return;
    while(current.queue.length){
      const next=current.queue[0];
      if(next.exclusive&&current.active)return;
      current.queue.shift();current.active++;current.exclusive=next.exclusive;
      let released=false;
      next.resolve(()=>{if(released)return;released=true;current.active--;if(next.exclusive)current.exclusive=false;drain();if(!current.active&&!current.queue.length)gates.delete(id);});
      if(next.exclusive)return;
    }
  };
  return new Promise(resolve=>{current.queue.push({exclusive,resolve});drain();});
}

/** Notes in one library remain concurrent; only archive transitions are exclusive. */
export const acquireLibraryActivity=(id:string)=>acquire(id,false);
export const acquireLibraryTransition=(id:string)=>acquire(id,true);

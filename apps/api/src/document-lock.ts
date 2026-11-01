const tails=new Map<string,Promise<void>>();
/** A gate shared by websocket messages and API edits to the same live document. */
export async function acquireDocument(id:string){
  const previous=tails.get(id)||Promise.resolve();let unlock!:()=>void;
  const held=new Promise<void>(resolve=>unlock=resolve),tail=previous.catch(()=>{}).then(()=>held);
  tails.set(id,tail);await previous.catch(()=>{});
  return ()=>{unlock();if(tails.get(id)===tail)tails.delete(id);};
}

const tails=new Map<string,Promise<void>>();

/** Separate from the edit gate: Documents.access holds the edit gate while
 * loading a document, so onLoadDocument must not acquire that gate again. */
export async function withStateEncodingLock<T>(id:string,operation:()=>Promise<T>){
  const previous=tails.get(id)||Promise.resolve();let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),tail=previous.catch(()=>{}).then(()=>held);tails.set(id,tail);
  await previous.catch(()=>{});
  try{return await operation();}finally{release();if(tails.get(id)===tail)tails.delete(id);}
}

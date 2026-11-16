const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only ANote document routes can be treated as internal note references. */
export function noteIdFromHref(href:unknown,origin?:string):string|null {
  if(typeof href!=="string"||!href||href!==href.trim())return null;
  // Relative references have one canonical spelling; reject protocol-relative URLs.
  if(href.startsWith("/")){
    const match=/^\/\?doc=([0-9a-f-]+)$/i.exec(href);
    return match&&uuid.test(match[1])?match[1].toLowerCase():null;
  }
  if(!origin)return null;
  try{
    const base=new URL(origin),url=new URL(href);
    if(!["http:","https:"].includes(url.protocol)||url.origin!==base.origin||url.username||url.password||url.pathname!=="/"||url.hash)return null;
    if(url.searchParams.getAll("doc").length!==1)return null;
    const id=url.searchParams.get("doc");return id&&uuid.test(id)?id.toLowerCase():null;
  }catch{return null;}
}

export function noteHref(id:string):string {
  if(!uuid.test(id))throw new Error("笔记标识无效");
  return "/?doc="+id.toLowerCase();
}

/** Preserve first appearance while deduplicating marks split by other formatting. */
export function referencedNoteIds(document:unknown,origin?:string):string[] {
  const ids=new Set<string>();
  function visit(value:unknown){
    if(!value||typeof value!=="object")return;
    const node=value as {marks?:{type?:string|{name?:string};attrs?:{href?:unknown}}[];content?:unknown[]|{forEach:(callback:(child:unknown)=>void)=>void}};
    for(const mark of Array.isArray(node.marks)?node.marks:[]){
      if((typeof mark.type==="string"?mark.type:mark.type?.name)!=="link")continue;
      const id=noteIdFromHref(mark.attrs?.href,origin);if(id)ids.add(id);
    }
    if(Array.isArray(node.content))for(const child of node.content)visit(child);
    else if(node.content&&typeof node.content.forEach==="function")node.content.forEach(visit);
  }
  visit(document);return [...ids];
}

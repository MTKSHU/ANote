/** A short plain-text preview; never expose URLs, node attributes or markup. */
export function noteExcerpt(snapshot:unknown, title="", limit=180):string {
  const stack:unknown[]=[snapshot],parts:string[]=[];
  let length=0;
  while(stack.length && length<=limit) {
    const node=stack.pop() as {type?:string;text?:unknown;content?:unknown[]}|null;
    if(!node || typeof node!=="object")continue;
    if(node.type==="text" && typeof node.text==="string") {
      const text=Array.from(node.text).slice(0,limit+1).join("");
      parts.push(text);length+=Array.from(text).length;
    } else if(Array.isArray(node.content)) {
      if(["paragraph","heading","codeBlock"].includes(node.type||"")) {
        const text=node.content.filter((child:any)=>child?.type==="text"&&typeof child.text==="string").map((child:any)=>child.text).join("").replace(/\s+/gu," ").trim();
        if(node.type==="heading" && !parts.length && text===title.trim())continue;
        if(parts.length){parts.push(" ");length++;}
      }
      stack.push(...node.content.slice().reverse());
    } else if(node.type==="hardBreak") {parts.push(" ");length++;}
  }
  const text=Array.from(parts.join("").replace(/\s+/gu," ").trim());
  return text.slice(0,limit).join("")+(text.length>limit||stack.length?"…":"");
}

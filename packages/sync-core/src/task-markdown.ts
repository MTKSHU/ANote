import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/** Keep checkbox groups, ordinary bullets and nested lists distinct. */
export function taskMarkdown(md:MarkdownIt){
  md.core.ruler.after("inline","anote_tasks",state=>{
    function close(tokens:Token[],start:number){let depth=0;for(let i=start;i<tokens.length;i++){depth+=tokens[i].nesting;if(depth===0)return i;}return tokens.length-1;}
    function convert(tokens:Token[]):Token[]{
      const out:Token[]=[];
      for(let i=0;i<tokens.length;i++){
        if(tokens[i].type!=="bullet_list_open"){out.push(tokens[i]);continue;}
        const end=close(tokens,i),groups:{task:boolean;items:Token[]}[]=[];
        for(let j=i+1;j<end;){
          const last=close(tokens,j),item=convert(tokens.slice(j,last+1)),inline=item.find(t=>t.type==="inline"),match=inline&&/^\[([ xX]?)\](?:[ \t]+|$)/.exec(inline.content);
          const task=!!match;
          if(match&&inline){
            item[0].attrSet("data-type","taskItem");item[0].attrSet("data-checked",String(match[1].toLowerCase()==="x"));
            inline.content=inline.content.slice(match[0].length);
            if(inline.children?.[0]?.type==="text")inline.children[0].content=inline.children[0].content.slice(match[0].length);
          }
          if(groups.at(-1)?.task===task)groups.at(-1)!.items.push(...item);else groups.push({task,items:item});j=last+1;
        }
        for(const group of groups){const open=new state.Token("bullet_list_open","ul",1),endToken=new state.Token("bullet_list_close","ul",-1);open.block=true;endToken.block=true;if(group.task)open.attrSet("data-type","taskList");out.push(open,...group.items,endToken);}i=end;
      }
      return out;
    }
    state.tokens=convert(state.tokens);
  });
}

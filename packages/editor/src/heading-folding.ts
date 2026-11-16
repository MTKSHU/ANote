import { t as translateUI } from "@anote/i18n";
import {Extension,type Editor} from '@tiptap/core';
import {Plugin,PluginKey,TextSelection} from '@tiptap/pm/state';
import {Decoration,DecorationSet,type EditorView} from '@tiptap/pm/view';
import type {Node} from '@tiptap/pm/model';

type Section={pos:number;from:number;to:number;children:{pos:number;size:number}[];label:string};
type FoldState={collapsed:Map<number,string|null>;sections:Section[];decorations:DecorationSet};
const key=new PluginKey<FoldState>('anote-heading-folding');

function sections(doc:Node){
  const result:Section[]=[];
  const visit=(parent:Node,start:number)=>{
    const children:{node:Node;pos:number}[]=[];parent.forEach((node,offset)=>children.push({node,pos:start+offset}));
    children.forEach(({node,pos},index)=>{
      if(node.type.name==='heading'&&index+1<children.length){
        let end=index+1;while(end<children.length&&(children[end].node.type.name!=='heading'||children[end].node.attrs.level>node.attrs.level))end++;
        if(end>index+1)result.push({pos,from:pos+node.nodeSize,to:end<children.length?children[end].pos:start+parent.content.size,label:node.textContent||translateUI("未命名标题"),children:children.slice(index+1,end).map(item=>({pos:item.pos,size:item.node.nodeSize}))});
      }
      if(node.childCount&&!node.isTextblock)visit(node,pos+1);
    });
  };
  visit(doc,0);return result;
}
function build(doc:Node,collapsed:FoldState['collapsed'],ranges=sections(doc)):FoldState{
  const decorations:Decoration[]=[];
  for(const section of ranges){
    const folded=collapsed.has(section.pos);
    const heading=doc.nodeAt(section.pos)!;
    decorations.push(Decoration.node(section.pos,section.pos+heading.nodeSize,{'aria-label':section.label}));
    decorations.push(Decoration.widget(section.pos+1,view=>{
      const button=document.createElement('button');button.type='button';button.className='heading-fold-toggle';button.dataset.headingPos=String(section.pos);button.contentEditable='false';button.setAttribute('aria-expanded',String(!folded));button.setAttribute('aria-label',translateUI("{0}“{1}”的内容", [folded?translateUI("展开"):translateUI("折叠"), section.label]));button.title=button.getAttribute('aria-label')!;
      button.innerHTML='<span aria-hidden="true" class="heading-fold-chevron"></span>';
      button.addEventListener('mousedown',event=>event.preventDefault());
      button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(view.composing)return;
        // Widget DOM can be reused while typing changes a section's end.
        // Resolve today's range before moving a caret out of hidden content.
        const current=key.getState(view.state),range=current?.sections.find(value=>value.pos===section.pos);if(!current||!range)return;
        const tr=view.state.tr.setMeta(key,{toggle:range.pos});
        if(!current.collapsed.has(range.pos)&&view.state.selection.from<range.to&&view.state.selection.to>=range.from)tr.setSelection(TextSelection.near(view.state.doc.resolve(range.from-1)));
        view.dispatch(tr);if(event.detail===0)queueMicrotask(()=>view.dom.querySelector<HTMLButtonElement>(`button[data-heading-pos="${section.pos}"]`)?.focus());
      });return button;
    },{key:`fold:${section.pos}:${folded}:${section.label}`,side:-1,stopEvent:()=>true,ignoreSelection:true}));
    if(folded)for(const child of section.children)decorations.push(Decoration.node(child.pos,child.pos+child.size,{class:'heading-fold-hidden'}));
  }
  return {collapsed,sections:ranges,decorations:DecorationSet.create(doc,decorations)};
}
function reveal(view:EditorView,position:number){
  const state=key.getState(view.state);if(!state)return false;
  const enclosing=state.sections.filter(section=>state.collapsed.has(section.pos)&&position>=section.from&&position<section.to);
  if(!enclosing.length)return false;
  view.dispatch(view.state.tr.setMeta(key,{reveal:enclosing.map(section=>section.pos)}));return true;
}
export function revealHeadingSection(editor:Editor,position:number){return reveal(editor.view,position);}

/** Folding is view state only: it never enters Yjs, snapshots or undo history. */
export const HeadingFolding=Extension.create({
  name:'headingFolding',
  addProseMirrorPlugins(){return [new Plugin<FoldState>({
    key,
    state:{
      init:(_,state)=>build(state.doc,new Map()),
      apply(tr,previous){
        const action=tr.getMeta(key);if(!tr.docChanged&&!action)return previous;
        const collapsed=new Map<number,string|null>(),ranges=sections(tr.doc),identities=new Map<string,number[]>();
        for(const section of ranges){const id=tr.doc.nodeAt(section.pos)?.attrs.blockId;if(id){const values=identities.get(id)||[];values.push(section.pos);identities.set(id,values);}}
        for(const [pos,id]of previous.collapsed){const mapped=tr.mapping.mapResult(pos,1),node=tr.doc.nodeAt(mapped.pos);
          if(id){const candidates=identities.get(id);if(candidates?.length)collapsed.set(candidates.reduce((best,value)=>Math.abs(value-mapped.pos)<Math.abs(best-mapped.pos)?value:best),id);}
          else if(!mapped.deletedAcross&&node?.type.name==='heading')collapsed.set(mapped.pos,null);
        }
        if(action?.toggle!==undefined){const pos=action.toggle;if(collapsed.has(pos))collapsed.delete(pos);else collapsed.set(pos,tr.doc.nodeAt(pos)?.attrs.blockId||null);}
        for(const pos of action?.reveal||[])collapsed.delete(pos);
        return build(tr.doc,collapsed,ranges);
      },
    },
    props:{
      decorations:state=>key.getState(state)?.decorations,
      handleKeyDown(view,event){
        if(view.composing||!view.state.selection.empty)return false;
        // Reveal hidden content before a boundary deletion can join or erase it.
        const head=view.state.selection.head;
        if(event.key==='Delete')return reveal(view,head+1);
        if(event.key==='Backspace')return reveal(view,head-2);
        return false;
      },
    },
    appendTransaction(transactions,oldState,state){
      if(!transactions.some(tr=>tr.selectionSet&&!tr.docChanged&&!tr.getMeta(key))||oldState.selection.eq(state.selection))return null;
      const current=key.getState(state);if(!current)return null;
      const selection=state.selection,hidden=current.sections.filter(section=>current.collapsed.has(section.pos)&&(selection.empty?selection.head>=section.from&&selection.head<section.to:selection.from<section.to&&selection.to>section.from));
      return hidden.length?state.tr.setMeta(key,{reveal:hidden.map(section=>section.pos)}):null;
    },
  })];},
});

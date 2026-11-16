import type {Editor} from '@tiptap/core';
import {findTable,TableMap} from '@tiptap/pm/tables';
import {yUndoPluginKey} from '@tiptap/y-tiptap';

const MIN_WIDTH=48,MAX_WIDTH=10000;
const clamp=(width:number)=>Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,Math.ceil(Number.isFinite(width)?width:MIN_WIDTH)));

/** Fit a whole table, retaining a readable minimum and exact integer totals. */
export function fitColumnWidths(preferred:number[],available:number){
  if(!preferred.length)return [];
  const widths=preferred.map(clamp),minimum=MIN_WIDTH*widths.length,total=widths.reduce((a,b)=>a+b,0);
  const target=Math.max(minimum,Math.min(total,Math.floor(Number.isFinite(available)?available:total)));
  if(target===total)return widths;
  // Keep short labels at their natural size; shrink the longest columns first.
  let low=MIN_WIDTH,high=Math.max(...widths);
  while(low<high){const cap=Math.ceil((low+high)/2);if(widths.reduce((sum,width)=>sum+Math.min(width,cap),0)<=target)low=cap;else high=cap-1;}
  const result=widths.map(width=>Math.min(width,low));
  let remaining=target-result.reduce((a,b)=>a+b,0);
  for(let index=0;index<widths.length&&remaining>0;index++)if(result[index]<widths[index]){result[index]++;remaining--;}
  return result;
}

// Measure rendered fonts without cloning media or triggering asset downloads.
// This runs only for an explicit toolbar action, never on typing/transactions.
function contentWidth(cell:HTMLElement,context:CanvasRenderingContext2D,limit:number){
  const win=cell.ownerDocument.defaultView!;
  let line=0,longest=0;
  const flush=()=>{longest=Math.max(longest,line);line=0;};
  const visit=(node:Node)=>{
    if(node.nodeType===Node.TEXT_NODE){
      const text=node.textContent||'',style=win.getComputedStyle(node.parentElement!);
      context.font=style.font||`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const lines=/pre|break-spaces/.test(style.whiteSpace)?text.replace(/\t/g,'    ').split('\n'):[text.replace(/\s+/g,' ')];
      lines.forEach((text,index)=>{if(index)flush();line+=Math.min(limit,context.measureText(text).width+Math.max(0,text.length-1)*(parseFloat(style.letterSpacing)||0));});
      return;
    }
    if(!(node instanceof HTMLElement)&&!(node instanceof SVGElement))return;
    const tag=node.tagName.toLowerCase(),style=win.getComputedStyle(node);
    if(style.display==='none'||['button','script','style','input'].includes(tag))return;
    if(tag==='br'){flush();return;}
    if(node.matches('.media-resource,.comparison,.mind-map,svg,img,video,audio,canvas,math')){line+=Math.min(limit,node.getBoundingClientRect().width||100);return;}
    const block=['block','list-item','flex','grid','table'].includes(style.display);
    if(block)flush();
    const indent=(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0);line+=indent;
    node.childNodes.forEach(visit);
    if(block)flush();
  };
  cell.childNodes.forEach(visit);flush();
  const style=win.getComputedStyle(cell),padding=(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0);
  return clamp(Math.min(limit,longest+padding+4));
}

export function adjustTableColumns(editor:Editor,mode:'content'|'equal'){
  if(!editor.isEditable)return false;
  const table=findTable(editor.state.selection.$from);if(!table)return false;
  const map=TableMap.get(table.node);if(map.problems?.length)return false;
  const dom=editor.view.nodeDOM(table.pos) as HTMLElement|null,element=dom?.tagName==='TABLE'?dom as HTMLTableElement:dom?.querySelector('table');
  if(!element)return false;
  const available=Math.floor(element.closest('.tableWrapper')?.clientWidth||editor.view.dom.clientWidth);if(available<=0)return false;
  let preferred=Array(map.width).fill(Math.max(MIN_WIDTH,Math.ceil(available/map.width))) as number[];
  if(mode==='content'){
    const context=element.ownerDocument.createElement('canvas').getContext('2d');if(!context)return false;
    preferred.fill(MIN_WIDTH);
    const spans:Array<{left:number;right:number;width:number}>=[];
    for(const offset of new Set(map.map)){
      const cell=editor.view.nodeDOM(table.start+offset) as HTMLElement|null;if(!cell)continue;
      const rect=map.findCell(offset),width=contentWidth(cell,context,available);
      if(rect.right-rect.left===1)preferred[rect.left]=Math.max(preferred[rect.left],width);
      else spans.push({...rect,width});
    }
    for(const span of spans){
      const current=preferred.slice(span.left,span.right).reduce((a,b)=>a+b,0),extra=Math.max(0,span.width-current)/(span.right-span.left);
      for(let col=span.left;col<span.right;col++)preferred[col]+=extra;
    }
  }
  const widths=fitColumnWidths(preferred,available),transaction=editor.state.tr;
  for(const offset of new Set(map.map)){
    const cell=table.node.nodeAt(offset)!;const rect=map.findCell(offset),colwidth=widths.slice(rect.left,rect.right);
    if(!cell.attrs.colwidth||colwidth.some((width,index)=>width!==cell.attrs.colwidth[index]))transaction.setNodeMarkup(table.start+offset,undefined,{...cell.attrs,colwidth});
  }
  if(!transaction.docChanged)return true;
  const undo=yUndoPluginKey.getState(editor.state)?.undoManager;undo?.stopCapturing();
  if(editor.state.storedMarks)transaction.setStoredMarks(editor.state.storedMarks);
  editor.view.dispatch(transaction);undo?.stopCapturing();editor.commands.focus(null,{scrollIntoView:false});return true;
}

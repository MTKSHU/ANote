import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {EditorState} from '@tiptap/pm/state';
import {initProseMirrorDoc,prosemirrorJSONToYDoc,ySyncPlugin,ySyncPluginKey,yUndoPlugin,yUndoPluginKey,undo,redo} from '@tiptap/y-tiptap';
import {schema} from '../../packages/document-model/src/model.js';
import {findAnchor,resolveAnchor} from '../../packages/document-model/src/anchors.js';

const paragraph=(text:string)=>({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]});
function fixture(){
  const quote='原文定位必须保留',prefix='说明：',target=prefix+quote+'。',document=prosemirrorJSONToYDoc(schema,{type:'doc',content:[paragraph('开头。'),paragraph(target),paragraph('结尾。')]},'default'),fragment=document.getXmlFragment('default'),initial=initProseMirrorDoc(fragment,schema);
  let state=EditorState.create({schema,doc:initial.doc,plugins:[ySyncPlugin(fragment,{mapping:initial.mapping}),yUndoPlugin()]});
  const binding=ySyncPluginKey.getState(state)!.binding,view={state};
  // The public sync plugin computes real migration plans from transactions.
  // A state-only view is sufficient for the binding's write path; no DOM,
  // hand-authored migration records or replaced anchor IDs are involved.
  binding.prosemirrorView=view as any;binding.syncedDoc=state.doc;
  const anchor=findAnchor(document,quote)!;assert.ok(anchor);
  const unchanged=JSON.stringify(anchor),peer=new Y.Doc();
  function apply(transaction:any){const manager=yUndoPluginKey.getState(state)!.undoManager;manager.stopCapturing();state=state.apply(transaction);view.state=state;binding._prosemirrorChanged(state.doc,ySyncPluginKey.getState(state)!.positionMigration);manager.stopCapturing();}
  function position(text:string){let found=-1;state.doc.forEach((node,pos)=>{if(node.textContent.includes(text))found=pos;});assert.ok(found>=0);return found;}
  function check(){assert.equal(JSON.stringify(anchor),unchanged);assert.deepEqual({text:resolveAnchor(document,anchor).text,orphaned:resolveAnchor(document,anchor).orphaned},{text:quote,orphaned:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));assert.deepEqual({text:resolveAnchor(peer,anchor).text,orphaned:resolveAnchor(peer,anchor).orphaned},{text:quote,orphaned:false});}
  function close(){yUndoPluginKey.getState(state)!.undoManager.destroy();binding.prosemirrorView=null;document.destroy();peer.destroy();}
  return {document,fragment,anchor,quote,prefix,target,peer,apply,position,check,close,get state(){return state;}};
}

test('valid raw same-XmlText anchors retain local indexes without full projection',()=>{
  const f=fixture();try{
    const original=f.fragment.toArray;f.fragment.toArray=()=>{throw new Error('Raw text anchors must not project the whole document');};
    try{assert.deepEqual(resolveAnchor(f.document,f.anchor),{text:f.quote,orphaned:false,start:f.prefix.length,end:f.prefix.length+f.quote.length});}finally{f.fragment.toArray=original;}
  }finally{f.close();}
});

test('persisted original range IDs resolve after split, join and same-node move on another document',()=>{
  const f=fixture();try{
    const split=f.position(f.quote)+1+f.prefix.length;f.apply(f.state.tr.split(split,1,[{type:schema.nodes.paragraph,attrs:{blockId:randomUUID()}}]));f.check();
    const join=f.position(f.quote);f.apply(f.state.tr.join(join));f.check();
    const from=f.position(f.quote),node=f.state.doc.nodeAt(from)!;const move=f.state.tr.delete(from,from+node.nodeSize);move.insert(move.doc.content.size,node);f.apply(move);f.check();
  }finally{f.close();}
});

test('true structural deletion remains orphaned and undo/redo restores original range IDs across peers',()=>{
  const f=fixture();try{
    const from=f.position(f.quote),node=f.state.doc.nodeAt(from)!;f.apply(f.state.tr.delete(from,from+node.nodeSize));assert.equal(resolveAnchor(f.document,f.anchor).orphaned,true);
    Y.applyUpdate(f.peer,Y.encodeStateAsUpdate(f.document));assert.equal(resolveAnchor(f.peer,f.anchor).orphaned,true);
    assert.equal(undo(f.state),true);f.check();assert.equal(redo(f.state),true);assert.equal(resolveAnchor(f.document,f.anchor).orphaned,true);
    Y.applyUpdate(f.peer,Y.encodeStateAsUpdate(f.document));assert.equal(resolveAnchor(f.peer,f.anchor).orphaned,true);
  }finally{f.close();}
});

test('fallback projection is reused until a transaction, including delete-only invalidation',()=>{
  const f=fixture();try{
    const from=f.position(f.quote),node=f.state.doc.nodeAt(from)!;const move=f.state.tr.delete(from,from+node.nodeSize);move.insert(move.doc.content.size,node);f.apply(move);
    const first=f.fragment.get(0) as Y.XmlElement,original=first.getAttributes;let reads=0;first.getAttributes=function(){reads++;return original.call(this);};
    try{
      f.check();const initialReads=reads;assert.ok(initialReads>0);f.check();assert.equal(reads,initialReads,'Repeated comments should reuse the same projection');
      const text=first.get(0) as Y.XmlText;const beforeVector=Y.encodeStateVector(f.document);text.delete(0,1);assert.deepEqual(Y.encodeStateVector(f.document),beforeVector,'Deletion must invalidate even without a new structure clock');f.check();assert.ok(reads>initialReads);
    }finally{first.getAttributes=original;}
  }finally{f.close();}
});

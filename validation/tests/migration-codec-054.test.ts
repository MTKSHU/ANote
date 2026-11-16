import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import * as Y from 'yjs';
import {EditorState} from '@tiptap/pm/state';
import {initProseMirrorDoc,prosemirrorJSONToYDoc,ySyncPlugin,ySyncPluginKey,yUndoPlugin,yUndoPluginKey,undo,redo} from '@tiptap/y-tiptap';
import {schema} from '../../packages/document-model/src/model.js';
import {findAnchor,resolveAnchor} from '../../packages/document-model/src/anchors.js';
import {createANoteMigrationCodec,encodePositionMigration,decodePositionMigration,isEncodedPositionMigration,scanDocumentMigrationEncoding,validateDocumentMigrationValues,setDocumentMigrationEncoding,compactDocumentMigrationValues,type PositionMigration} from '../../patches/y-tiptap-migration-codec.mjs';
import {historyHeavyTodo052} from '../fixtures/history-heavy-todo-052';
const codec=createANoteMigrationCodec(),hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const transfer=(client:number,clock:number,target:number|null,extras:any={})=>({source:{client,clock,length:3},target:target===null?null:{client:client+1,clock:target,type:{client:client+2,clock:20}},...extras});
const record=(transfers:any[],extras:any={}):PositionMigration=>({version:1,client:10,clock:100,seen:[[1,20]],transfers,...extras});

test('migration binary round trips order, large safe integers and every optional field without losing causal metadata',()=>{
  const value=record([
    transfer(9,80,120),transfer(7,15,null),transfer(9,5,60),
    {source:{client:0,clock:0,length:1,boundary:undefined},target:{client:0,clock:0,type:null,tname:undefined,assoc:undefined,boundary:undefined}},
    {source:{client:0,clock:2,length:2,boundary:null},target:{client:1,clock:4,type:undefined,tname:null,assoc:null,boundary:null}},
    {source:{client:0,clock:7,length:1,boundary:'end'},target:{client:2,clock:9,tname:'根\ud800名称😀',assoc:-7,boundary:'start'}},
    {source:{client:4294967295,clock:Number.MAX_SAFE_INTEGER-12,length:2,boundary:'start'},target:{client:4294967295,clock:Number.MAX_SAFE_INTEGER-5,type:{client:4294967295,clock:Number.MAX_SAFE_INTEGER-2},assoc:1}},
  ],{clock:Number.MAX_SAFE_INTEGER,seen:[[4294967295,Number.MAX_SAFE_INTEGER],[0,0],[10,10]]});
  const bytes=encodePositionMigration(value);assert(isEncodedPositionMigration(bytes));assert.deepEqual(decodePositionMigration(bytes),value);assert.deepEqual(encodePositionMigration(decodePositionMigration(bytes)),bytes);
  for(let end=0;end<bytes.length;end++)assert.throws(()=>{const partial=decodePositionMigration(bytes.subarray(0,end));void partial.transfers;},/Invalid/);
  const trailing=new Uint8Array(bytes.length+1);trailing.set(bytes);assert.throws(()=>decodePositionMigration(trailing),/Invalid/);
  assert.throws(()=>encodePositionMigration({...value,unsupported:true} as any),/Invalid/);
});

test('randomized interval queries and complete decoding match legacy candidates including causal overrides and boundary ambiguity',()=>{
  let seed=0x540054;const random=(limit:number)=>{seed=(seed*1664525+1013904223)>>>0;return seed%limit;};
  const doc=new Y.Doc(),store=doc.getMap<any>('__tiptap_position_migrations:root:default'),legacy:any[]=[];
  try{
    for(let index=0;index<12;index++){
      const transfers=Array.from({length:180+random(60)},()=>{const source:any={client:1+random(4),clock:random(500),length:1+random(40)};if(random(3)===0)source.boundary=random(2)?'start':'end';const target:any=random(6)?{client:5+random(4),clock:random(900),type:random(3)?{client:5+random(4),clock:random(100)}:null}:null;if(target){if(random(2))target.assoc=random(3)-1;if(random(6)===0)target.tname='default';if(random(6)===0)target.boundary=random(2)?'start':'end';}return {source,target};});
      const value=record(transfers,{client:index+10,clock:index+100,seen:index?[[index+9,index+100]]:[]});legacy.push(value);const bytes=encodePositionMigration(value);assert.deepEqual(decodePositionMigration(bytes),value);store.set(String(index),index%2?bytes:value);
    }
    for(let index=0;index<1500;index++){
      const id={client:1+random(6),clock:random(560)},position:any=random(3)?{item:id,type:null,assoc:random(3)-1}:{item:null,type:id,assoc:random(2)?-1:0},boundary=position.item?undefined:position.assoc<0?'start':'end';
      const all=legacy.flatMap(migration=>migration.transfers.filter((transfer:any)=>transfer.source.client===id.client&&transfer.source.boundary===boundary&&transfer.source.clock<=id.clock&&id.clock<transfer.source.clock+transfer.source.length).map((transfer:any)=>({migration,transfer})));
      const expected=all.filter(candidate=>!all.some(other=>other.migration!==candidate.migration&&other.migration.seen.some(([client,clock]:number[])=>client===candidate.migration.client&&clock>candidate.migration.clock)));
      const project=(rows:any[])=>rows.map(({migration,transfer})=>({client:migration.client,clock:migration.clock,seen:migration.seen,transfer}));assert.deepEqual(project(codec.candidates(store,position)),project(expected));
    }
  }finally{doc.destroy();}
});

test('replacing a map value without changing map size invalidates candidate caches, including reads inside a transaction',()=>{
  const doc=new Y.Doc(),store=doc.getMap<any>('__tiptap_position_migrations:root:default'),position={item:{client:1,clock:12},type:null,assoc:0};
  try{
    store.set('same',encodePositionMigration(record([transfer(1,10,50)])));assert.equal(codec.candidates(store,position)[0].transfer.target!.clock,50);
    store.set('same',encodePositionMigration(record([transfer(1,10,80)])));assert.equal(store.size,1);assert.equal(codec.candidates(store,position)[0].transfer.target!.clock,80);
    doc.transact(()=>{store.set('same',encodePositionMigration(record([transfer(1,10,120)])));assert.equal(codec.candidates(store,position)[0].transfer.target!.clock,120);});
    assert.equal(codec.candidates(store,position)[0].transfer.target!.clock,120);
  }finally{doc.destroy();}
});

test('shadow compaction retains every migration and CRDT identity, shrinks the 17MiB fixture, and old replay cannot resurrect JSON',t=>{
  const fixture=historyHeavyTodo052(),shadow=new Y.Doc(),late=new Y.Doc(),before=Y.encodeStateAsUpdate(fixture.document),original=[...fixture.document.getMap<any>('__tiptap_position_migrations:root:default').entries()];
  try{
    Y.applyUpdate(shadow,before);Y.applyUpdate(late,before);const oldFragment=shadow.getXmlFragment('default'),firstId=(oldFragment.get(0) as any)._item.id,stats=compactDocumentMigrationValues(shadow),after=Y.encodeStateAsUpdate(shadow);
    assert.equal(stats.converted,562);assert.equal(stats.transfers,160376);assert(after.length<before.length*0.3,`${before.length} -> ${after.length}`);assert.equal(scanDocumentMigrationEncoding(shadow),2);assert.deepEqual((oldFragment.get(0) as any)._item.id,firstId);
    assert.deepEqual(initProseMirrorDoc(oldFragment,schema).doc.toJSON(),fixture.snapshot);
    const map=shadow.getMap<any>('__tiptap_position_migrations:root:default');for(const [key,value]of original)assert.deepEqual(decodePositionMigration(map.get(key)),value);
    const compactHash=hash(after);Y.applyUpdate(shadow,before);assert.equal(hash(Y.encodeStateAsUpdate(shadow)),compactHash);assert([...map.values()].every(isEncodedPositionMigration));
    const again=compactDocumentMigrationValues(shadow);assert.equal(again.changed,false);assert.equal(hash(Y.encodeStateAsUpdate(shadow)),compactHash);assert.throws(()=>setDocumentMigrationEncoding(shadow,1),/downgraded/);
    late.getMap<any>('__tiptap_position_migrations:root:default').set('late-record',record([transfer(1,1,4)]));Y.applyUpdate(shadow,Y.encodeStateAsUpdate(late));assert.equal(scanDocumentMigrationEncoding(shadow),2);assert(original.every(([key])=>isEncodedPositionMigration(map.get(key))));assert.equal(compactDocumentMigrationValues(shadow).converted,1);
    t.diagnostic(JSON.stringify({beforeStateBytes:before.length,afterStateBytes:after.length,reductionPercent:100*(1-after.length/before.length),...stats,maxRssKiB:process.resourceUsage().maxRSS}));
  }finally{fixture.document.destroy();shadow.destroy();late.destroy();}
});

test('the binary schema is stable and full primitive validation fails atomically without materializing transfer objects',()=>{
  const value:PositionMigration={version:1,client:7,clock:2,seen:[[7,1]],transfers:[{source:{client:9,clock:10,length:3},target:null}]};
  const bytes=encodePositionMigration(value);assert.deepEqual([...bytes],[65,78,77,2,2,7,9,0,2,1,0,1,1,1,1,1,1,10,3,1,4,1,0,0,3]);
  const doc=new Y.Doc();try{
    const map=doc.getMap<any>('__tiptap_position_migrations:root:default');map.set('good',value);const broken=bytes.slice();broken[22]=7;map.set('broken',broken);const before=hash(Y.encodeStateAsUpdate(doc));
    assert.equal(scanDocumentMigrationEncoding(doc),2);assert.throws(()=>validateDocumentMigrationValues(doc),/Invalid/);assert.throws(()=>compactDocumentMigrationValues(doc),/Invalid/);assert.equal(hash(Y.encodeStateAsUpdate(doc)),before);assert.equal(map.get('good'),value);
    map.set('broken',bytes);assert.equal(validateDocumentMigrationValues(doc),2);assert.equal(compactDocumentMigrationValues(doc).converted,1);assert.deepEqual(decodePositionMigration(map.get('broken')),value);
    doc.getMap('__anote_sync_meta').set('migrationEncoding',3);assert.throws(()=>setDocumentMigrationEncoding(doc,2),/Invalid/);
  }finally{doc.destroy();}
});

test('the document marker is idempotent and cannot hide existing binary migrations',()=>{
  const doc=new Y.Doc();try{assert.equal(scanDocumentMigrationEncoding(doc),1);setDocumentMigrationEncoding(doc,2);const first=hash(Y.encodeStateAsUpdate(doc));setDocumentMigrationEncoding(doc,2);assert.equal(hash(Y.encodeStateAsUpdate(doc)),first);assert.throws(()=>setDocumentMigrationEncoding(doc,1),/downgraded/);doc.getMap<any>('__tiptap_position_migrations:root:default').set('record',encodePositionMigration(record([transfer(1,1,4)])));doc.getMap('__anote_sync_meta').set('migrationEncoding',1);assert.equal(scanDocumentMigrationEncoding(doc),2);compactDocumentMigrationValues(doc);assert.equal(doc.getMap('__anote_sync_meta').get('migrationEncoding'),2);}finally{doc.destroy();}
});

test('patched y-tiptap preserves original comment anchors through compaction, move, delete, undo/redo and peer reload',()=>{
  const paragraph=(text:string)=>({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]}),quote='原始批注定位',document=prosemirrorJSONToYDoc(schema,{type:'doc',content:[paragraph('第一段'),paragraph('前缀'+quote+'后缀'),paragraph('最后一段')]},'default'),fragment=document.getXmlFragment('default'),initial=initProseMirrorDoc(fragment,schema);
  let state=EditorState.create({schema,doc:initial.doc,plugins:[ySyncPlugin(fragment,{mapping:initial.mapping}),yUndoPlugin()]}),view={state};const binding=ySyncPluginKey.getState(state)!.binding;binding.prosemirrorView=view as any;binding.syncedDoc=state.doc;const anchor=findAnchor(document,quote)!;assert(anchor);
  const manager=yUndoPluginKey.getState(state)!.undoManager,peer=new Y.Doc();
  const apply=(transaction:any)=>{manager.stopCapturing();state=state.apply(transaction);view.state=state;binding._prosemirrorChanged(state.doc,ySyncPluginKey.getState(state)!.positionMigration);manager.stopCapturing();};
  const check=()=>{assert.equal(resolveAnchor(document,anchor).text,quote);assert.equal(resolveAnchor(document,anchor).orphaned,false);Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));assert.equal(resolveAnchor(peer,anchor).text,quote);};
  try{
    let from=0;state.doc.forEach((node,pos)=>{if(node.textContent.includes(quote))from=pos;});const node=state.doc.nodeAt(from)!;const moving=state.tr.delete(from,from+node.nodeSize);moving.insert(moving.doc.content.size,node);apply(moving);check();
    const migrations=document.getMap<any>('__tiptap_position_migrations:root:default');assert(migrations.size>0);assert.equal(scanDocumentMigrationEncoding(document),1);assert([...migrations.values()].every(value=>!isEncodedPositionMigration(value)));
    compactDocumentMigrationValues(document);check();assert.equal(scanDocumentMigrationEncoding(document),2);
    // A later structural edit must write compact values and exercise the
    // decoder on undo's historical-transfer graph.
    const at=state.doc.content.size-state.doc.lastChild!.nodeSize;apply(state.tr.delete(at,at+state.doc.lastChild!.nodeSize));assert.equal(resolveAnchor(document,anchor).orphaned,true);assert.equal(undo(state),true);check();assert.equal(redo(state),true);assert.equal(resolveAnchor(document,anchor).orphaned,true);
    assert([...document.getMap<any>('__tiptap_position_migrations:root:default').values()].every(isEncodedPositionMigration));
  }finally{manager.destroy();binding.prosemirrorView=null;document.destroy();peer.destroy();}
});

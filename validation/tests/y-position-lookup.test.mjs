import test from "node:test";
import assert from "node:assert/strict";
import {Schema} from "@tiptap/pm/model";
import {EditorState} from "@tiptap/pm/state";
import {createANoteMovedPositionFinder} from "../../patches/y-tiptap-position-lookup.mjs";

const schema=new Schema({nodes:{doc:{content:"block*"},paragraph:{content:"inline*",group:"block"},container:{content:"block*",group:"block"},blockAtom:{content:"block*",group:"block",atom:true},leaf:{group:"block",atom:true},text:{group:"inline"},inlineLeaf:{inline:true,group:"inline",atom:true},inlineAtom:{inline:true,group:"inline",content:"inline*",atom:true}}});
const paragraph=text=>schema.node("paragraph",null,text?[schema.text(text)]:[]),container=children=>schema.node("container",null,children),document=children=>schema.node("doc",null,children);
const indexNodes=doc=>{const result=new Map();doc.descendants((node,pos)=>{const positions=result.get(node)||[];positions.push(pos);result.set(node,positions);});return result;};
function findMovedNode(node,offset,step,indexes){if(indexes[step].get(node)?.length!==1)return null;for(let target=step+1;target<indexes.length;target++){const next=indexes[target].get(node);if(next?.length===1)return {position:next[0]+offset,step:target};}return null;}
// Upstream 3.0.10 reference implementation, MIT @tiptap/y-tiptap.
function legacy(position,step,docs,indexes){const original=docs[step].resolve(position),candidates=[],child=docs[step].nodeAt(position);if(child&&!child.isText)candidates.push({node:child,offset:0});for(let depth=original.depth;depth>0;depth--)candidates.push({node:original.node(depth),offset:position-original.before(depth)});for(const candidate of candidates){const moved=findMovedNode(candidate.node,candidate.offset,step,indexes);if(moved)return moved;}return null;}
const optimized=createANoteMovedPositionFinder(findMovedNode);
function compare(docs){const indexes=docs.map(indexNodes);let count=0;for(let step=0;step<docs.length;step++)for(let position=0;position<=docs[step].content.size;position++){assert.deepEqual(optimized(position,step,docs,indexes),legacy(position,step,docs,indexes),`step ${step} position ${position}`);count++;}return count;}

test("position lookup matches upstream for nested moves, leaf boundaries, empty blocks and duplicate node objects",()=>{
  const repeated=paragraph("same identity"),empty=paragraph(""),leaf=schema.node("leaf"),inline=paragraph("head 中文😀é"),mixed=schema.node("paragraph",null,[schema.text("中😀é"),schema.node("inlineLeaf"),schema.text("cd中文")]);
  const first=document([container([repeated,empty,container([mixed,leaf])]),inline,repeated]),second=document([inline,container([empty,mixed]),repeated,leaf]),third=document([repeated,leaf,inline,container([empty,mixed])]);
  assert.ok(compare([first,second,third])>100);
});

test("nonleaf block and inline atoms preserve inner/closing-token candidates through moves",()=>{
  const inline=schema.node("inlineAtom",null,[schema.text("atomic text"),schema.node("inlineLeaf")]),mixed=schema.node("paragraph",null,[schema.node("inlineLeaf"),inline,schema.text("tail")]),atom=schema.node("blockAtom",null,[container([]),mixed,paragraph("")]);
  assert.ok(compare([document([atom,schema.node("leaf"),mixed]),document([mixed,atom]),document([container([atom]),mixed])])>100);
});

test("position lookup matches upstream for real delete, split, join and multi-step move transactions",()=>{
  const start=document([container([paragraph("first paragraph"),paragraph("second paragraph"),paragraph("third paragraph")]),paragraph("outside")]);
  const state=EditorState.create({schema,doc:start}),deletion=state.tr.delete(1,18),split=state.tr.split(7),join=state.tr.join(18),moved=state.tr;
  const node=start.child(0);moved.delete(0,node.nodeSize);moved.insert(moved.doc.content.size,node);
  for(const transaction of [deletion,split,join,moved])assert.ok(compare([...transaction.docs,transaction.doc])>0);
});

test("randomized persistent trees retain exactly the same move candidates at every document position",()=>{
  let seed=0x51a0b;const random=limit=>{seed=(seed*1664525+1013904223)>>>0;return seed%limit;};let compared=0;
  for(let run=0;run<180;run++){
    const leaves=Array.from({length:4+random(10)},(_,index)=>random(5)===0?schema.node("leaf"):paragraph(random(4)===0?"":"node-"+index+"-"+"x".repeat(random(16))));
    const branches=leaves.map((node,index)=>index%2===0?container([node,leaves[(index+1)%leaves.length]]):node);
    const before=document([container(branches.slice(0,4)),...branches.slice(4)]),after=document([...branches.filter(()=>random(3)!==0).sort(()=>random(3)-1),container([branches[random(branches.length)],paragraph("")])]),last=document([container([branches[0],branches[0]]),...branches.slice().reverse()]);
    compared+=compare([before,after,last]);
  }
  assert.ok(compared>30000);
});

test("empty document and out-of-range boundaries preserve upstream results and errors",()=>{
  const docs=[document([]),document([paragraph("")])],indexes=docs.map(indexNodes);assert.equal(optimized(0,0,docs,indexes),null);
  for(const position of [-1,docs[1].content.size+1]){assert.throws(()=>optimized(position,1,docs,indexes),RangeError);assert.throws(()=>legacy(position,1,docs,indexes),RangeError);}
});

test("large structural deletion uses the index rather than ProseMirror's per-character linear resolvers",()=>{
  const before=document([container(Array.from({length:2000},(_,index)=>paragraph("todo "+index+" text ".repeat(15)))),paragraph("retained")]),after=document([before.lastChild]),docs=[before,after],indexes=docs.map(indexNodes);
  const resolve=before.resolve,nodeAt=before.nodeAt;let calls=0;before.resolve=()=>{calls++;throw new Error("linear resolve must not be used");};before.nodeAt=()=>{calls++;throw new Error("linear nodeAt must not be used");};
  try{for(let position=0;position<=before.content.size;position++)optimized(position,0,docs,indexes);assert.equal(calls,0);}finally{before.resolve=resolve;before.nodeAt=nodeAt;}
});

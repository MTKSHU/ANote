import test from "node:test";
import assert from "node:assert/strict";
import {canonical,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {exportMarkdown,mergeMarkdown} from "@anote/sync-core";
import {validateRichDocument,editorRules} from "../../apps/api/src/mcp-model.js";
const document=()=>canonical({type:"doc",content:[
  {type:"mindMap",attrs:{blockId:"map",canvasHeight:640},content:[{type:"mindMapItem",attrs:{id:"root",parentId:null,x:320,y:180},content:[{type:"text",text:"长文字保持原样"}]}]},
  {type:"codeBlock",attrs:{blockId:"mermaid",language:"mermaid",canvasHeight:720},content:[{type:"text",text:"flowchart LR\nA[研究步骤]-->B[结果]"}]},
]});
test("画布高度默认值、合法范围与 MCP 规则一致，拒绝无效尺寸",()=>{
  assert.equal(EDITOR_SCHEMA_VERSION,9);assert.deepEqual(validateRichDocument(document()),document());
  const legacy=canonical({type:"doc",content:[{type:"codeBlock",attrs:{language:"mermaid"}}]});assert.equal(legacy.content[0].attrs!.canvasHeight,420);
  assert.equal(editorRules().node_types.mindMap.attributes.canvasHeight,420);assert.equal(editorRules().node_types.codeBlock.attributes.canvasHeight,420);
  for(const node of [0,1])for(const height of [239,1601,640.5,"640",null]){const value=document();value.content[node].attrs!.canvasHeight=height;assert.throws(()=>validateRichDocument(value));}
});
test("Markdown 修改图表源码保留作者高度，远端调整高度可与本地源码修改合并",()=>{
  const base=document(),remote=structuredClone(base);remote.content[0].attrs!.canvasHeight=900;remote.content[1].attrs!.canvasHeight=960;
  const markdown=exportMarkdown("note","base",base).replace("研究步骤","补充研究步骤"),merged=mergeMarkdown(base,remote,markdown);
  assert.equal(merged.conflicts.length,0);assert.deepEqual(merged.doc.content[0],remote.content[0]);assert.equal(merged.doc.content[1].attrs!.canvasHeight,960);assert.match(merged.doc.content[1].content![0].text!,/补充研究步骤/);
});

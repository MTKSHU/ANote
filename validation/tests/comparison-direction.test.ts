import {test} from "node:test";
import assert from "node:assert/strict";
import {canonical} from "@anote/document-model";
import {exportMarkdown,mergeMarkdown} from "@anote/sync-core";
import {validateRichDocument} from "../../apps/api/src/mcp-model.js";
test("上下对比方向可由 MCP 表达，Markdown 合并保留方向、Alpha 原图和视图参数，旧图默认左右",()=>{
  const legacy=canonical({type:"doc",content:[{type:"imageComparison",attrs:{blockId:"pair",images:[{assetId:"before"},{assetId:"after"}]}},{type:"paragraph",attrs:{blockId:"p"},content:[{type:"text",text:"初稿"}]}]});assert.equal(legacy.content[0].attrs!.orientation,"horizontal");const vertical=structuredClone(legacy);vertical.content[0].attrs!.orientation="vertical";vertical.content[0].attrs!.slider=28;const result=mergeMarkdown(legacy,vertical,exportMarkdown("note","base",legacy).replace("初稿","追加说明"));assert.equal(result.conflicts.length,0);assert.deepEqual(result.doc.content[0],vertical.content[0]);assert.deepEqual(validateRichDocument(result.doc),result.doc);const invalid=structuredClone(vertical);invalid.content[0].attrs!.orientation="diagonal";assert.throws(()=>validateRichDocument(invalid));
});

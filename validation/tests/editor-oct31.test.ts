import {test} from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import {canonical,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {taskMarkdown} from "@anote/sync-core/task-markdown";
import {renderBlock,exportMarkdown,mergeMarkdown,parseStandard} from "@anote/sync-core";
import {validateRichDocument,editBlocks} from "../../apps/api/src/mcp-model.js";
test("待办标准 Markdown、嵌套、空标记兼容与勾选状态可往返",()=>{
  assert.equal(EDITOR_SCHEMA_VERSION,4);
  const body="- [ ] 未完成\n- [x] 已完成\n  - [] 子任务";
  const block=parseStandard({id:"todo",type:"taskList",body,protected:false});
  assert.equal(block.type,"taskList");assert.equal(block.content![0].attrs!.checked,false);assert.equal(block.content![1].attrs!.checked,true);
  assert.equal(block.content![1].content![1].type,"taskList");
  assert.deepEqual(parseStandard({id:"todo",type:"taskList",body:renderBlock(block),protected:false}),block);
  const doc=canonical({type:"doc",content:[block,{type:"paragraph",attrs:{blockId:"p"},content:[{type:"text",text:"结论"}]}]});
  const markdown=exportMarkdown("doc","base",doc),result=mergeMarkdown(doc,doc,markdown.replace("- [ ] 未完成","- [x] 未完成"));assert.equal(result.conflicts.length,0);assert.equal(result.doc.content[0].content![0].attrs!.checked,true);assert.deepEqual(result.doc.content[1],doc.content[1]);
});
test("混合待办和普通列表保留各自语义，不改变代码和转义标记",()=>{
  const md=new MarkdownIt({html:false}).use(taskMarkdown),html=md.render("- 普通项目\n- [ ] 任务\n- 普通项目二\n\n`- [ ] 代码`\n\n- \\[ ] 转义");
  assert.equal((html.match(/data-type="taskList"/g)||[]).length,1);assert.equal((html.match(/data-type="taskItem"/g)||[]).length,1);assert.match(html,/<code>- \[ \] 代码<\/code>/);
});
test("未修改的旧版多图与嵌套空 ID 保持原样，新对比只接受两张滑动图",()=>{
  const legacy=canonical({type:"doc",content:[{type:"imageComparison",attrs:{blockId:"images",images:[{assetId:"a"},{assetId:"b"},{assetId:"c"}],layout:"grid"}},{type:"taskList",attrs:{blockId:"todo"},content:[{type:"taskItem",attrs:{checked:false},content:[{type:"paragraph",content:[{type:"text",text:"任务"}]}]}]}]});
  assert.deepEqual(validateRichDocument(legacy),legacy);
  const changed=editBlocks(legacy,[{action:"insert",node:{type:"paragraph",content:[{type:"text",text:"追加"}]}}]);assert.deepEqual(changed.content.slice(0,2),legacy.content);
  assert.throws(()=>editBlocks(legacy,[{action:"insert",node:legacy.content[0]}]));
  assert.throws(()=>validateRichDocument({type:"doc",content:[{type:"taskList",content:[{type:"taskItem",attrs:{checked:"yes"},content:[{type:"paragraph"}]}]}]}));
});

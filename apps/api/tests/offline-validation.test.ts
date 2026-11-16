import {test} from "node:test";
import assert from "node:assert/strict";
import {EditorState} from "@tiptap/pm/state";
import {schema,canonical,type RichDoc} from "@anote/document-model";
import {validateEditorDocument,validateRichDocument} from "../src/mcp-model.js";

test("真实ProseMirror引用内拆段保留nested ID，离线传输接受且不重写正文或身份",()=>{
  const before=canonical({type:"doc",content:[{type:"blockquote",attrs:{blockId:"quote"},content:[{type:"paragraph",attrs:{blockId:"nested"},content:[{type:"text",text:"AB",marks:[{type:"bold"}]}]}]}]});
  const state=EditorState.create({schema,doc:schema.nodeFromJSON(before)}),split=state.tr.split(3).doc.toJSON() as RichDoc;
  assert.deepEqual(split.content[0].content!.map(node=>node.attrs?.blockId),["nested","nested"]);
  assert.throws(()=>validateRichDocument(split),error=>(error as any).getResponse?.().error==="内容块 ID 重复");
  assert.deepEqual(validateEditorDocument(split),canonical(split));
  assert.deepEqual(split.content[0].content!.map(node=>node.content?.[0].text),["A","B"]);
});

test("离线验证保留表格与列表中的nested IDs，MCP仍拒绝跨层重复身份",()=>{
  const value=canonical({type:"doc",content:[{type:"bulletList",attrs:{blockId:"list"},content:[{type:"listItem",content:[{type:"paragraph",attrs:{blockId:"nested"},content:[{type:"text",text:"第一项"}]}]},{type:"listItem",content:[{type:"paragraph",attrs:{blockId:"nested"},content:[{type:"text",text:"第二项"}]}]}]},{type:"table",attrs:{blockId:"table"},content:[{type:"tableRow",content:[{type:"tableCell",content:[{type:"paragraph",attrs:{blockId:"nested"},content:[{type:"text",text:"单元格一"}]}]},{type:"tableCell",content:[{type:"paragraph",attrs:{blockId:"nested"},content:[{type:"text",text:"单元格二"}]}]}]}]}]});
  assert.deepEqual(validateEditorDocument(value),value);assert.throws(()=>validateRichDocument(value),error=>(error as any).getResponse?.().error==="内容块 ID 重复");
});

test("离线验证仍拒绝重复顶层ID、非法nested ID与危险结构",()=>{
  for(const value of [
    {type:"doc",content:[{type:"paragraph",attrs:{blockId:"same"}},{type:"paragraph",attrs:{blockId:"same"}}]},
    {type:"doc",content:[{type:"blockquote",attrs:{blockId:"quote"},content:[{type:"paragraph",attrs:{blockId:"bad id"}}]}]},
    {type:"doc",content:[{type:"paragraph",attrs:{blockId:"p"},content:[{type:"text",text:"危险",marks:[{type:"link",attrs:{href:"javascript:alert(1)"}}]}]}]},
    {type:"doc",content:[{type:"unknownNode"}]},
  ])assert.throws(()=>validateEditorDocument(value as RichDoc));
});

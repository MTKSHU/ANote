import {test} from "node:test";
import assert from "node:assert/strict";
import {canonical} from "@anote/document-model";
import {exportMarkdown,mergeMarkdown} from "@anote/sync-core";
import {validateRichDocument} from "../../apps/api/src/mcp-model.js";
import {noteExcerpt} from "../../apps/api/src/note-excerpt.js";
test("摘要提取正文，跳过重复标题、属性和图片路径，并按 Unicode 截断",()=>{
  const snapshot={type:"doc",content:[{type:"heading",content:[{type:"text",text:"欢迎"}]},{type:"mediaResource",attrs:{title:"不应出现",localPath:"secret/path"}},{type:"paragraph",content:[{type:"text",text:"第一段"},{type:"hardBreak"},{type:"text",text:"第二行"}]}]};assert.equal(noteExcerpt(snapshot,"欢迎"),"第一段 第二行");assert.equal(noteExcerpt({type:"text",text:"🙂".repeat(200)},"",5),"🙂🙂🙂🙂🙂…");assert.equal(noteExcerpt(null),"");
});
test("提及在结构化内容、Markdown 同步及 MCP 中保真，不伪造未知格式",()=>{
  const mention={type:"mention",attrs:{userId:"peer",actorId:"owner",mentionId:"mention-1"}},base=canonical({type:"doc",content:[{type:"paragraph",attrs:{blockId:"p"},content:[{type:"text",text:"@同事",marks:[mention]},{type:"text",text:" 请查看结果"}]}]});
  assert.deepEqual(validateRichDocument(base),base);const markdown=exportMarkdown("note","base",base),merged=mergeMarkdown(base,base,markdown.replace("请查看结果","请查看新结果"));assert.equal(merged.conflicts.length,0);assert.deepEqual(merged.doc.content[0].content![0].marks,[mention]);assert.match(markdown,/@同事/);const invalid=structuredClone(base);invalid.content[0].content![0].marks![0].attrs!.userId="<script>";assert.throws(()=>validateRichDocument(invalid));
});

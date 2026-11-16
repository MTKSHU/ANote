import assert from "node:assert/strict";
import {test} from "node:test";
import {noteHref,noteIdFromHref,referencedNoteIds} from "../../packages/document-model/src/note-links";
import {schema} from "../../packages/document-model/src/model";
import {validateRichDocument} from "../../apps/api/src/mcp-model";

const first="e8789f78-bc4d-4cc6-b65a-63ce14831556",second="d06f24fd-683d-46a9-b98b-637694c806c7",origin="https://notes.example.test";
test("note routes stay on this service and reject executable, ambiguous and malformed references",()=>{
  assert.equal(noteHref(first.toUpperCase()),"/?doc="+first);
  assert.equal(noteIdFromHref(noteHref(first)),first);
  assert.equal(noteIdFromHref(origin+"/?doc="+second+"&scope=personal",origin),second);
  for(const href of ["javascript:alert(1)","data:text/html,test","//evil.example/?doc="+first,"https://evil.example/?doc="+first,"/?doc=123","/?doc="+first+"&doc="+second,"/?doc="+first+"#fragment"," /?doc="+first,"/api/documents/"+first,origin+"/other?doc="+first,origin+"/?doc="+first+"&doc="+second])assert.equal(noteIdFromHref(href,origin),null,href);
  assert.throws(()=>noteHref("../../private"));
});

test("references deduplicate split link marks in first appearance order without collecting external URLs",()=>{
  const text=(value:string,href:string,bold=false)=>({type:"text",text:value,marks:[{type:"link",attrs:{href}},...(bold?[{type:"bold"}]:[])]});
  const document={type:"doc",content:[{type:"paragraph",content:[text("初次",noteHref(first)),text("加粗",noteHref(first),true),text("第二篇",noteHref(second)),text("外部",`https://other.test/?doc=${first}`)]},{type:"paragraph",content:[text("重复",noteHref(first))]}]};
  assert.deepEqual(referencedNoteIds(document,origin),[first,second]);
  assert.deepEqual(referencedNoteIds(schema.nodeFromJSON(document),origin),[first,second]);
});

test("server transport accepts canonical note marks while rejecting arbitrary relative and executable paths",()=>{
  const document=(href:string)=>({type:"doc" as const,content:[{type:"paragraph",content:[{type:"text",text:"参考",marks:[{type:"link",attrs:{href}}]}]}]});
  assert.equal(validateRichDocument(document(noteHref(first))).content[0].content?.[0].marks?.[0].attrs?.href,noteHref(first));
  for(const href of ["/?doc=invalid","/api/settings","/?doc="+first+"&redirect=https://evil.test","//evil.test/","javascript:alert(1)"])assert.throws(()=>validateRichDocument(document(href)),href);
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {validateRichDocument,editBlocks,noteHash} from "../../apps/api/src/mcp-model.js";
const paragraph=(text:string,id?:string)=>({type:"paragraph",...(id?{attrs:{blockId:id}}:{}),content:[{type:"text",text} ]});
test("MCP 富文本补齐默认属性和稳定 ID，表格与导图结构保持",()=>{
 const doc=validateRichDocument({type:"doc",content:[{type:"heading",content:[{type:"text",text:"默认标题"}]},{type:"table",content:[{type:"tableRow",content:[{type:"tableCell",content:[paragraph("合并")],attrs:{colspan:2}}]},{type:"tableRow",content:[{type:"tableCell",content:[paragraph("A")]},{type:"tableCell",content:[paragraph("B")]}]}]},{type:"mindMap",content:[{type:"mindMapItem",attrs:{id:"root"},content:[{type:"text",text:"中心"}]}]}]});
 assert.equal(doc.content[0].attrs?.level,1);assert.equal(doc.content[1].content?.[0].content?.[0].attrs?.colspan,2);assert.equal(doc.content[2].content?.[0].attrs?.x,320);
 assert.deepEqual(validateRichDocument(doc),doc);
});
test("MCP 拒绝不完整合并表格、循环导图、危险链接和无效格式",()=>{
 const bad:any[]=[{type:"table",content:[{type:"tableRow",content:[{type:"tableCell",attrs:{rowspan:2},content:[paragraph("bad")]}]}]},
 {type:"mindMap",content:[{type:"mindMapItem",attrs:{id:"a",parentId:"b",x:0,y:0}},{type:"mindMapItem",attrs:{id:"b",parentId:"a",x:1,y:1}}]},
 {type:"paragraph",content:[{type:"text",text:"bad",marks:[{type:"link",attrs:{href:"javascript:alert(1)"}}]}]},
 {type:"paragraph",content:[{type:"text",text:"bad",marks:[{type:"textStyle",attrs:{fontSize:999,color:"red"}}]}]},
 {type:"paragraph",attrs:{role:"admin"},content:[]},
 {type:"heading",attrs:{level:6},content:[]}];
 for(const node of bad)assert.throws(()=>validateRichDocument({type:"doc",content:[node]}));
});
test("MCP 块操作保持未修改富文本，支持插入、重排、删除与空文档",()=>{
 const before=validateRichDocument({type:"doc",content:[paragraph("甲","a"),paragraph("乙","b"),{type:"codeBlock",attrs:{blockId:"c",language:"mermaid"},content:[{type:"text",text:"flowchart LR\nA-->B"}]}]});
 const updated=editBlocks(before,[{action:"replace",block_id:"a",node:paragraph("新甲")},{action:"move",block_id:"c",before_id:"a"},{action:"delete",block_id:"b"}]);
 assert.deepEqual(updated.content.map(n=>n.attrs?.blockId),["c","a"]);assert.deepEqual(updated.content[0],before.content[2]);
 assert.equal(editBlocks(updated,[{action:"delete",block_id:"c"},{action:"delete",block_id:"a"}]).content[0].type,"paragraph");
 assert.throws(()=>editBlocks(before,[{action:"delete",block_id:"missing"}]));
});
test("MCP 预览版本同时绑定正文、标题和标签",()=>{
 const note={space_id:"s",folder_id:null,title:"标题",tags:[],snapshot:validateRichDocument({type:"doc",content:[paragraph("内容")]})};
 assert.notEqual(noteHash(note),noteHash({...note,title:"新标题"}));assert.notEqual(noteHash(note),noteHash({...note,tags:["新标签"]}));
});

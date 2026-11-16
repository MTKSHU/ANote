import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,firstLineIndentCSS,EDITOR_SCHEMA_VERSION,type RichDoc} from '@anote/document-model';
import {validateRichDocument,editorRules} from '@anote/sync-core/mcp-model';
import {exportMarkdown,mergeMarkdown} from '@anote/sync-core';

test('additive paragraph and cell attributes leave unformatted schema 8 snapshots unchanged',()=>{
  const before=canonical({type:'doc',content:[{type:'paragraph',attrs:{blockId:'plain'},content:[{type:'text',text:'保留原有内容'}]},{type:'table',attrs:{blockId:'table'},content:[{type:'tableRow',content:[{type:'tableCell',content:[{type:'paragraph'}]}]}]}]});
  assert.equal(EDITOR_SCHEMA_VERSION,9);assert(!JSON.stringify(before).includes('firstLineIndent'));assert(!JSON.stringify(before).includes('verticalAlign'));
  assert.deepEqual(validateRichDocument(before),before);
});
test('two-character indentation uses the first text size and does not alter text or heading layout',()=>{
  const plain={type:'paragraph',attrs:{firstLineIndent:2},content:[{type:'text',text:'中文'}]};assert.equal(firstLineIndentCSS(plain),'2em');
  assert.equal(firstLineIndentCSS({...plain,content:[{type:'text',text:'中文',marks:[{type:'textStyle',attrs:{fontSize:24}}]}]}),'48px');
  assert.equal(firstLineIndentCSS({...plain,type:'heading'}),undefined);assert.equal(firstLineIndentCSS({...plain,attrs:{}}),undefined);
});
test('MCP validates semantic layout attributes and publishes their allowed values',()=>{
  const value:RichDoc={type:'doc',content:[{type:'paragraph',attrs:{blockId:'body',firstLineIndent:2},content:[{type:'text',text:'正文'}]},{type:'table',attrs:{blockId:'table'},content:[{type:'tableRow',content:[{type:'tableHeader',attrs:{verticalAlign:'middle',background:'#dbeafe',colwidth:[180]},content:[{type:'paragraph'}]}]}]}]};
  const valid=validateRichDocument(value);assert.equal(valid.content[0].attrs!.firstLineIndent,2);assert.equal(valid.content[1].content![0].content![0].attrs!.verticalAlign,'middle');
  for(const bad of [0,1,'2',null])assert.throws(()=>validateRichDocument({...value,content:[{...value.content[0],attrs:{blockId:'body',firstLineIndent:bad}}]}));
  assert.deepEqual(editorRules().formatting.tableCell.verticalAlign.values,['top','middle','bottom']);
});
test('plain Markdown text edits inherit structured first-line indentation',()=>{
  const base=canonical({type:'doc',content:[{type:'paragraph',attrs:{blockId:'paragraph',firstLineIndent:2,textAlign:'justify'},content:[{type:'text',text:'原正文'}]}]});
  const source=exportMarkdown('note','base',base),edited=source.replace('原正文','修改后正文'),merged=mergeMarkdown(base,base,edited);
  assert.equal(merged.conflicts.length,0);assert.equal(merged.doc.content[0].attrs!.firstLineIndent,2);assert.equal(merged.doc.content[0].attrs!.textAlign,'justify');assert.equal(merged.doc.content[0].content![0].text,'修改后正文');
});

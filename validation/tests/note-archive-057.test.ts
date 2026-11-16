import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ZipReader,BlobReader,Uint8ArrayWriter} from '@zip.js/zip.js';
import type {RichDoc} from '@anote/document-model';
import {noteAssetIds,noteMarkdown,prepareMarkdownArchive} from '../../packages/sync-core/src/note-markdown.js';
import {writeMarkdownArchive} from '../../packages/sync-core/src/note-archive.js';
const binary=new Map([['image-a',new Uint8Array([0,1,127,128,254,255])],['image-b',new TextEncoder().encode('<svg>原始图片</svg>')],['audio-c',new Uint8Array([82,73,70,70,0,255,23,0])]]),snapshot:RichDoc={type:'doc',content:[{type:'heading',attrs:{level:1},content:[{type:'text',text:'完整正文'}]},...['image-a','image-a','audio-c'].map(id=>({type:'mediaResource',attrs:{assetId:id,kind:id==='audio-c'?'audio':'image',title:id,src:'/api/assets/'+id+'/file'}})),{type:'imageComparison',attrs:{images:[{assetId:'image-a',label:'甲'},{assetId:'image-b',label:'乙'}]}},{type:'paragraph',content:[{type:'text',text:'附件链接',marks:[{type:'link',attrs:{href:'https://notes.example/api/assets/image-b/file?download=1#page=2'}}]},{type:'text',text:'外部地址',marks:[{type:'link',attrs:{href:'https://other.invalid/api/assets/never/file'}}]}]}]};
const metadata=async(id:string)=>({id,filename:id==='audio-c'?'录音.wav':'图 )片#.png',bytes:binary.get(id)!.length});
async function blobOutput(plan:any,read:(id:string)=>Promise<Response>,options:any={}){const output=new TransformStream<Uint8Array,Uint8Array>(),done=new Response(output.readable).blob();void done.catch(()=>{});await writeMarkdownArchive(plan,output.writable,read,options);return done;}
test('Markdown archive includes exact binary files once, safe relative paths and original unsaved text',async()=>{
  const before=structuredClone(snapshot),seen:string[]=[],reads:string[]=[],plan=await prepareMarkdownArchive(snapshot,'研究/笔记','https://notes.example',async id=>{seen.push(id);return metadata(id);});assert.equal(seen.length,3);assert.deepEqual(noteAssetIds(snapshot,'https://notes.example'),['image-a','audio-c','image-b']);assert.equal(plan.filename,'研究_笔记.md');assert.match(plan.markdown,/# 研究\/笔记/);assert(!plan.markdown.includes('/api/assets/image-'));assert(plan.markdown.includes('%29'));assert(plan.markdown.includes('#page=2'));assert(plan.markdown.includes('https://other.invalid/api/assets/never/file'));
  const blob=await blobOutput(plan,async id=>{reads.push(id);return new Response(binary.get(id));});assert.equal(reads.length,3);
  const reader=new ZipReader(new BlobReader(blob),{useWebWorkers:false}),entries=await reader.getEntries();assert.equal(entries.length,4);const md=entries.find(e=>e.filename===plan.filename)!;assert(!md.directory);assert.equal(new TextDecoder().decode(await md.getData!(new Uint8ArrayWriter())),plan.markdown);
  for(const asset of plan.assets){const entry=entries.find(e=>e.filename===asset.path)!;assert(!entry.directory);assert.deepEqual(await entry.getData!(new Uint8ArrayWriter()),binary.get(asset.id));assert(!entry.filename.includes('..'));}
  await reader.close();assert.deepEqual(snapshot,before);await fs.mkdir('artifacts/note-layout-057',{recursive:true});await fs.writeFile('artifacts/note-layout-057/markdown-unit.zip',new Uint8Array(await blob.arrayBuffer()));
});
test('Missing, denied or truncated assets abort rather than return incomplete archives',async()=>{
  const plan=await prepareMarkdownArchive(snapshot,'失败处理','https://notes.example',metadata);
  await assert.rejects(blobOutput(plan,async()=>new Response('denied',{status:403})),/403/);
  await assert.rejects(blobOutput(plan,async()=>new Response(new Uint8Array([1]))),/不完整/);
  await assert.rejects(prepareMarkdownArchive(snapshot,'容量限制','https://notes.example',metadata,1),/上限/);
  await assert.rejects(blobOutput(plan,async id=>new Response(binary.get(id)),{active:()=>false}),/已切换/);
});
test('Archive naming prevents traversal and a failed destination propagates cleanly',async()=>{
  const plan=await prepareMarkdownArchive(snapshot,'../名称','https://notes.example',async id=>({...await metadata(id),filename:'../../恶意\\路径?.png'}));assert(plan.assets.every(a=>!a.path.slice('assets/'.length).includes('/')&&!a.path.includes('\\')));
  const output=new WritableStream<Uint8Array>({write(){throw new Error('disk full');}});await assert.rejects(writeMarkdownArchive(plan,output,async id=>new Response(binary.get(id))),/disk full/);
  assert.equal(noteAssetIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'普通文字'}]}]}).length,0);assert(noteMarkdown({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'普通文字'}]}]},'标题').includes('普通文字'));
});
test('Long Unicode filenames remain portable and preserve their extensions',async()=>{
  const plan=await prepareMarkdownArchive(snapshot,'中文标题'.repeat(100),'https://notes.example',async id=>({...await metadata(id),filename:'超长中文文件名'.repeat(100)+'.pdf'}));assert(Buffer.byteLength(plan.filename)<=184);for(const asset of plan.assets){assert(Buffer.byteLength(asset.path.slice('assets/'.length))<=240);assert(asset.path.endsWith('.pdf'));}
});
test('Only current-platform asset links are bundled; other origins and file URLs remain links',()=>{
 const snapshot:RichDoc={type:'doc',content:[{type:'paragraph',content:['https://other.invalid/api/assets/a/file','file:///api/assets/b/file','anote://other/api/assets/c/file'].map(href=>({type:'text',text:'外部引用',marks:[{type:'link',attrs:{href}}]}))}]};assert.deepEqual(noteAssetIds(snapshot,'https://notes.example'),[]);
});

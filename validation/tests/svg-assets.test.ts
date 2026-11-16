import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createHash,randomUUID} from "node:crypto";
import {isSvgImagePrefix,SVG_MIME} from "@anote/document-model/svg";
import {describeFile,normalizeSvgAsset,storagePath,initializeStorage} from "../../apps/api/src/storage.js";
import {PersonalStore} from "../../apps/desktop/main/personal-store.mjs";
import {OfflineStore} from "../../apps/desktop/main/offline-store.mjs";
import {localAsset} from "../../apps/desktop/main/local-assets.mjs";

const svg=Buffer.from('\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- diagram -->\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><style>rect {fill:red}</style><rect width="120" height="60"/></svg>');
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");

test("SVG 识别基于 XML 根元素，支持 BOM/注释/命名空间，拒绝 HTML 伪装、DTD/实体、外部样式和截断根标签",()=>{
  assert.equal(isSvgImagePrefix(svg.toString()),true);
  assert.equal(isSvgImagePrefix('<s:svg width="20" xmlns:s="http://www.w3.org/2000/svg"><s:path/></s:svg>'),true);
  for(const value of ['<html><svg xmlns="http://www.w3.org/2000/svg"/></html>','<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>','<?xml-stylesheet href="https://external.invalid/a.css"?><svg xmlns="http://www.w3.org/2000/svg"/>','<svg xmlns="https://wrong.invalid"/>','<svg xmlns="http://www.w3.org/2000/svg"','<svg xmlns="http://www.w3.org/2000/svg" width="2"width="3">']) assert.equal(isSvgImagePrefix(value),false,value);
});

test("服务器按内容识别新 SVG，历史资源虚拟兼容且不修改文件或元数据",async t=>{
  assert.ok(process.env.ASSET_ROOT?.startsWith('/tmp/'),"Run SVG storage tests with an isolated /tmp ASSET_ROOT");
  await initializeStorage();const key=randomUUID()+'.bin',file=storagePath('originals',key);await fs.writeFile(file,svg);t.after(()=>fs.rm(file,{force:true}));
  assert.deepEqual(await describeFile(file,'diagram.SVG',svg.length),{kind:'image',mime:SVG_MIME,metadata:{}});
  assert.equal((await describeFile(file,'diagram.bin',svg.length)).mime,SVG_MIME);
  const legacy={kind:'file',mime:'application/octet-stream',filename:'diagram.svg',storage_key:key,bytes:svg.length};
  assert.equal((await normalizeSvgAsset(legacy)).mime,SVG_MIME);assert.equal(legacy.kind,'file');assert.deepEqual(await fs.readFile(file),svg);
  await fs.writeFile(file,'<html><svg xmlns="http://www.w3.org/2000/svg"/></html>');assert.equal((await normalizeSvgAsset(legacy)).kind,'file');
});

test("桌面本地 SVG 上传、历史附件、重启及 Range/HEAD 读取保留图像类型和安全策略",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-svg-personal-')),store=await new PersonalStore(directory).load();let reopened:any;
  t.after(async()=>{await store.close();await reopened?.close();await fs.rm(directory,{recursive:true,force:true});});
  const api=async(endpoint:string,method='GET',body?:any)=>{const url=new URL('anote://app/api/'+endpoint),response=await store.respond(new Request(url,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}),url);assert.equal(response.status,200);return response.json();};
  const book=await api('spaces','POST',{name:'SVG',kind:'personal'}),note=await api('documents','POST',{title:'SVG',space_id:book.id}),task=await api('uploads','POST',{doc_id:note.id,filename:'diagram.svg',hash:digest(svg),bytes:svg.length});
  const chunk=new URL('anote://app/api/uploads/'+task.id+'/chunk');assert.equal((await store.respond(new Request(chunk,{method:'PUT',headers:{'Upload-Offset':'0','X-Chunk-SHA256':digest(svg)},body:svg}),chunk)).status,200);
  const asset=await api('uploads/'+task.id+'/complete','POST',{});assert.equal(asset.kind,'image');assert.equal(asset.mime,SVG_MIME);
  Object.assign(store.index.assets[0],{kind:'file',mime:'application/octet-stream'});await store.write('catalog.json',store.index);
  assert.equal((await api('assets/'+asset.id)).kind,'image');assert.equal(store.index.assets[0].kind,'file');
  await store.close();reopened=await new PersonalStore(directory).load();
  const url=new URL('anote://app'+asset.url),head=await reopened.respond(new Request(url,{method:'HEAD'}),url);assert.equal(head.headers.get('Content-Type'),SVG_MIME);assert.equal((await head.arrayBuffer()).byteLength,0);assert.match(head.headers.get('Content-Security-Policy'),/^sandbox; default-src 'none'/);assert.equal(head.headers.get('X-Content-Type-Options'),'nosniff');
  const response=await reopened.respond(new Request(url,{headers:{Range:'bytes=3-18'}}),url);assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),svg.subarray(3,19));
});

test("已有服务器离线 SVG 副本无需联网或重下载即可显示，权限撤销仍禁止读取",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-svg-offline-')),session={profileRoot:directory,settings:{serverURL:'https://svg.example.test',user:{id:'owner'},offline:true},token:'test-only'},store=await new OfflineStore(session,()=>{},{fetch:async()=>{throw new Error('Network must not be used');}}).load();
  t.after(async()=>{await store.close();await fs.rm(directory,{recursive:true,force:true});});
  await fs.mkdir(path.join(store.root,'assets'),{recursive:true});const file='assets/'+randomUUID()+'.bin';await fs.writeFile(path.join(store.root,file),svg);
  store.data.documents.note={metadata:{id:'note',space_id:'book',title:'SVG'},assets:[{id:'svg',kind:'file',mime:'application/octet-stream',filename:'diagram.svg',bytes:svg.length,hash:digest(svg),url:'/api/assets/svg/file',available:true,file}]};
  const read=async(endpoint:string,method='GET')=>{const url=new URL('anote://app/api/'+endpoint);return store.read(new Request(url,{method}),url);};
  const metadata=await (await read('assets/svg')).json();assert.equal(metadata.mime,SVG_MIME);assert.equal(metadata.kind,'image');assert.equal(store.data.documents.note.assets[0].kind,'file');
  const response=await read('assets/svg/file','HEAD');assert.equal(response.headers.get('Content-Type'),SVG_MIME);assert.equal((await response.arrayBuffer()).byteLength,0);
  const thumbnail=await read('assets/svg/thumbnail');assert.equal(thumbnail.status,200);assert.equal(thumbnail.headers.get('Content-Type'),SVG_MIME);assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()),svg);
  await store.denyRecord('note','test revoked');assert.equal((await read('assets/svg/file')).status,403);
});

test("旧Markdown工作副本SVG按安全本地路径恢复类型，原件和sidecar不变且撤权不读取",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-svg-checkout-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'.anote'));await fs.mkdir(path.join(directory,'assets'));
  await fs.writeFile(path.join(directory,'assets','diagram.svg'),svg);
  const metadata=JSON.stringify({assets:[{id:'svg',path:'assets/diagram.svg',url:'/api/assets/svg/file',bytes:svg.length,mime:'application/octet-stream'}]}),sidecar=path.join(directory,'.anote','note.base.json');await fs.writeFile(sidecar,metadata);
  const session={settings:{user:{id:'owner'},serverURL:'https://svg.example.test',documents:[{id:'note',directory}]}},url=new URL('anote://app/api/assets/svg/file');
  const head=await localAsset(new Request(url,{method:'HEAD'}),url,session,()=>true);assert.equal(head.headers.get('Content-Type'),SVG_MIME);assert.equal((await head.arrayBuffer()).byteLength,0);
  const ranged=await localAsset(new Request(url,{headers:{Range:'bytes=3-18'}}),url,session,()=>true);assert.equal(ranged.status,206);assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),svg.subarray(3,19));assert.equal(await fs.readFile(sidecar,'utf8'),metadata);
  assert.equal(await localAsset(new Request(url),url,session,()=>false),null);
});

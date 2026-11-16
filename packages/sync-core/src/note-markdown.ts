import type {RichDoc,RichNode} from '@anote/document-model';
import {renderBlock} from './merge.js';

const validId=(value:unknown):value is string=>typeof value==='string'&&/^[-\w]{1,100}$/.test(value);
function utf8Prefix(value:string,max:number){let result='',bytes=0;for(let char of value){const point=char.codePointAt(0)!;if(point>=0xd800&&point<=0xdfff)char='�';const size=point>0xffff?4:point>0x7ff?3:point>0x7f?2:1;if(bytes+size>max)break;result+=char;bytes+=size;}return result;}
function safeName(value:string,max:number,extension=false){
  let safe=String(value||'').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().replace(/[. ]+$/g,'')||'未命名笔记';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe))safe='_'+safe;
  const ext=extension?/\.[a-z0-9]{1,12}$/i.exec(safe)?.[0]||'':'';
  return utf8Prefix(ext?safe.slice(0,-ext.length):safe,max-ext.length)+ext;
}
export const noteExportTitle=(title:string)=>safeName(title,180);
function assetLink(value:unknown,base:string){
  if(typeof value!=='string')return null;
  try{const home=new URL(base||'anote://app'),url=new URL(value,home);if(!['http:','https:','anote:'].includes(url.protocol)||url.protocol!==home.protocol||url.host!==home.host)return null;return /^\/api\/assets\/([-\w]{1,100})\/file$/.exec(url.pathname)?.[1]||null;}catch{return null;}
}
function visit(doc:RichNode,callback:(node:RichNode)=>void){callback(doc);for(const child of doc.content||[])visit(child,callback);}
export function noteAssetIds(snapshot:RichDoc,base=''){
  const ids=new Set<string>();visit(snapshot,node=>{
    if(node.type==='mediaResource'){const id=node.attrs?.assetId||assetLink(node.attrs?.src,base);if(!validId(id))throw new Error('存在尚未准备好的附件，请完成上传后再导出');ids.add(id);}
    if(node.type==='imageComparison')for(const item of node.attrs?.images||[]){if(!validId(item.assetId))throw new Error('对比图片缺少附件标识');ids.add(item.assetId);}
    for(const mark of node.marks||[])if(mark.type==='link'){const id=assetLink(mark.attrs?.href,base);if(id)ids.add(id);}
  });if(ids.size>2000)throw new Error('单次导出最多包含 2000 个附件');return [...ids];
}
function absolute(value:string,base:string){try{const url=new URL(value,base);return ['http:','https:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}}
export function noteMarkdown(snapshot:RichDoc,title:string,base='',paths=new Map<string,string>()){
  const copy=structuredClone(snapshot);
  visit(copy,node=>{
    if(node.marks)node.marks=node.marks.filter(mark=>mark.type!=='underline');
    for(const mark of node.marks||[])if(mark.type==='link'&&typeof mark.attrs?.href==='string'){const id=assetLink(mark.attrs.href,base);mark.attrs.href=id&&paths.has(id)?paths.get(id)+new URL(mark.attrs.href,base||'anote://app').hash:/^https?:/.test(base)?absolute(mark.attrs.href,base)||mark.attrs.href:mark.attrs.href;}
    if(node.type==='mediaResource'&&node.attrs){const id=node.attrs.assetId||assetLink(node.attrs.src,base),value=node.attrs.src||node.attrs.localPath;node.attrs.localPath=paths.get(id)||(/^https?:/.test(base)&&value?absolute(value,base)||value:node.attrs.localPath||value||'');}
    if(node.type==='imageComparison')for(const item of node.attrs?.images||[])item.localPath=paths.get(item.assetId)||(/^https?:/.test(base)&&item.src?absolute(item.src,base)||item.src:item.localPath||item.src);
  });
  return '# '+title.replace(/\r?\n/g,' ')+'\n\n'+copy.content.map(node=>{const body=renderBlock(node);return ['table','imageComparison','mediaResource','mindMap'].includes(node.type)?body.replace(/\n\n?> [^\n]*结构化版本[^\n]*$/,''):body;}).join('\n\n')+'\n';
}
export type ExportAsset={id:string;filename:string;bytes:number;mime?:string};
export type MarkdownArchive={filename:string;markdown:string;assets:(ExportAsset&{path:string})[]};
export async function prepareMarkdownArchive(snapshot:RichDoc,title:string,base:string,metadata:(id:string)=>Promise<ExportAsset>,maxBytes=Infinity,progress?:(message:string)=>void):Promise<MarkdownArchive>{
  const ids=noteAssetIds(snapshot,base),assets:MarkdownArchive['assets']=[],paths=new Map<string,string>();let total=0;
  for(const [index,id]of ids.entries()){
    progress?.(`正在准备附件 ${index+1}/${ids.length}`);const asset=await metadata(id);
    if(asset.id!==id||!Number.isSafeInteger(asset.bytes)||asset.bytes<0)throw new Error('附件信息无效，请刷新笔记后重试');
    total+=asset.bytes;if(total>maxBytes)throw new Error('附件超过当前浏览器的内存导出上限，请使用桌面客户端导出，或使用支持直接保存到文件的浏览器');
    const name=safeName(asset.filename||'附件',240-id.length-1,true),path='assets/'+id+'-'+name;
    assets.push({...asset,path});paths.set(id,path.split('/').map(part=>encodeURIComponent(part).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())).join('/'));
  }
  return {filename:noteExportTitle(title)+'.md',markdown:noteMarkdown(snapshot,title,base,paths),assets};
}

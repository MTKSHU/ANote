import { t as translateUI } from "@anote/i18n";
import {firstLineIndentCSS,type RichDoc,type RichNode} from "@anote/document-model";
import {beginPrintTitle} from "./page-title";
import {noteAssetIds,noteMarkdown,noteExportTitle,prepareMarkdownArchive} from '@anote/sync-core/note-markdown';
import {writeMarkdownArchive} from '@anote/sync-core/note-archive';

export type ExportSource={snapshot:RichDoc;element:HTMLElement};
type Picture={src:string;width:number;height:number};
const maxImage=20*1024*1024;
const titleName=(title:string)=>title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,"_").slice(0,120).trim()||translateUI("未命名笔记");
export async function exportNoteMarkdown(source:ExportSource,title:string,serverURL:string,progress?:(message:string)=>void){
  const snapshot=structuredClone(source.snapshot),ids=noteAssetIds(snapshot,serverURL),content=ids.length?'':noteMarkdown(snapshot,title,serverURL),baseName=noteExportTitle(title),exportId=crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(window.anote?.exportNoteMarkdown){
    const off=window.anote.onNoteExportProgress?.(value=>{if(value.id===exportId)progress?.(value.message);});
    try{const result=await window.anote.exportNoteMarkdown({content,title,snapshot,exportId});return result.saved?(result.archive?translateUI("Markdown 与附件已导出（解压后打开 .md）"):translateUI("Markdown 已导出")):translateUI("已取消导出");}finally{off?.();}
  }
  if(!ids.length){await downloadMarkdownFile(new Blob([content],{type:'text/markdown;charset=utf-8'}),baseName+'.md',content);return translateUI("Markdown 已导出");}
  const nativeAndroid=/ANoteMobile\//.test(navigator.userAgent);
  if(nativeAndroid&&(window as any).__anoteNativeExportVersion!==2)throw new Error(translateUI("请更新 Android 客户端后导出附件归档，或使用系统浏览器导出"));
  const picker=!nativeAndroid&&(window as any).showSaveFilePicker;
  let sink:WritableStream<Uint8Array>|undefined,blobPromise:Promise<Blob>|undefined;
  try{
    if(picker){const file=await picker.call(window,{suggestedName:baseName+'.zip',types:[{description:translateUI("Markdown 与附件归档"),accept:{'application/zip':['.zip']}}]});sink=await file.createWritable();}
    const limit=picker?Infinity:(nativeAndroid?128:256)*1024*1024;
    const metadata=async(id:string)=>{const response=await fetch('/api/assets/'+id,{credentials:'same-origin',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(translateUI("无法读取附件信息（{0}）", [response.status]));const asset=await response.json();return {id:asset.id,filename:asset.filename,bytes:Number(asset.bytes),mime:asset.mime};};
    const plan=await prepareMarkdownArchive(snapshot,title,serverURL,metadata,limit,progress);
    if(!sink){const output=new TransformStream<Uint8Array,Uint8Array>();sink=output.writable;blobPromise=new Response(output.readable,{headers:{'Content-Type':'application/zip'}}).blob();void blobPromise.catch(()=>{});}
    await writeMarkdownArchive(plan,sink,id=>fetch('/api/assets/'+id+'/file',{credentials:'same-origin',signal:AbortSignal.timeout(30*60*1000)}),{progress,maxBytes:limit});
    if(blobPromise){const blob=await blobPromise;if(blob.size>limit)throw new Error(translateUI("归档超过当前浏览器的内存导出上限，请使用桌面客户端"));if(!await downloadMarkdownFile(blob,baseName+'.zip'))return translateUI("已取消导出");}
    return translateUI("Markdown 与附件已导出（解压后打开 .md）");
  }catch(error){await sink?.abort(error).catch(()=>{});if((error as Error).name==='AbortError')return translateUI("已取消导出");throw error;}
}
async function downloadMarkdownFile(blob:Blob,filename:string,content?:string){
  const androidZip=content===undefined&&/ANoteMobile\//.test(navigator.userAgent);
  if(androidZip&&(window as any).__anoteMarkdownExport?.finish)throw new Error(translateUI("请先完成当前文件保存"));
  const anchor=document.createElement('a'),value:any={filename,mime:blob.type,length:blob.size,...(content!==undefined?{content}:{})};
  if(androidZip){
    const bytes=new Uint8Array(await blob.arrayBuffer());
    value.readChunk=(offset:number,length:number)=>{if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(length)||length<1||length>32768)throw new Error(translateUI("导出读取范围无效"));const part=bytes.subarray(offset,Math.min(bytes.length,offset+length));return btoa(String.fromCharCode(...part));};
  }
  const url=URL.createObjectURL(blob);value.url=url;let timer:ReturnType<typeof setTimeout>;
  value.dispose=()=>{clearTimeout(timer);URL.revokeObjectURL(url);if((window as any).__anoteMarkdownExport===value)delete (window as any).__anoteMarkdownExport;};
  const completed=androidZip?new Promise<boolean>((resolve,reject)=>{value.finish=(status:string)=>{value.dispose();if(status==='saved')resolve(true);else if(status==='canceled')resolve(false);else reject(new Error(translateUI("附件归档保存失败或已超时，请重新导出")));};}):Promise.resolve(true);
  (window as any).__anoteMarkdownExport?.dispose?.();(window as any).__anoteMarkdownExport=value;
  timer=setTimeout(()=>androidZip?value.finish('failed'):value.dispose(),androidZip?10*60*1000:60000);
  anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();return completed;
}

function link(value:string,base:string){try{const url=new URL(value,base);return ["http:","https:","mailto:"].includes(url.protocol)?url.href:null;}catch{return null;}}
function text(node:RichNode):string{return node.type==="text"?node.text||"":(node.content||[]).map(text).join("");}
function element(tag:string,value?:string){const node=document.createElement(tag);if(value!==undefined)node.textContent=value;return node;}
function hex(value:unknown){return typeof value==="string"&&/^#[a-f\d]{6}$/i.test(value)?value.slice(1):undefined;}
function blockElement(root:HTMLElement,node:RichNode){const id=node.attrs?.blockId;return id?[...root.querySelectorAll<HTMLElement>("[data-block-id]")].find(candidate=>candidate.dataset.blockId===id):undefined;}
async function image(source:string):Promise<HTMLImageElement>{const img=new Image();img.src=source;let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([img.decode(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(translateUI("图片载入超时"))),15000);})]);return img;}finally{clearTimeout(timeout);}}
async function raster(source:string):Promise<Picture>{const img=await image(source),scale=Math.min(1,2200/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext("2d")!.drawImage(img,0,0,canvas.width,canvas.height);return {src:canvas.toDataURL("image/png"),width:canvas.width,height:canvas.height};}
function cleanSVG(svg:SVGSVGElement){
  for(const item of [...svg.querySelectorAll("script,iframe,object,embed,link,form,button")])item.remove();
  for(const item of [svg,...svg.querySelectorAll("*")])for(const attr of [...item.attributes])if(/^on/i.test(attr.name)||["href","xlink:href"].includes(attr.name)&&!attr.value.startsWith("#"))item.removeAttribute(attr.name);
  for(const style of svg.querySelectorAll("style"))style.textContent=(style.textContent||"").replace(/@import[^;]+;/gi,"").replace(/url\((?!['"]?#)[^)]+\)/gi,"none");
  return svg;
}
function diagramPicture(root:HTMLElement,node:RichNode):Picture|null {
  const rendered=blockElement(root,node);let svg:SVGSVGElement|null=null,width=800,height=400;
  if(node.type==="mindMap"){
    const original=rendered?.querySelector<SVGSVGElement>(".mind-map-viewport>svg");if(!original)return null;
    const group=original.querySelector<SVGGElement>(":scope>g");if(!group)return null;const bounds=group.getBBox();if(!bounds.width||!bounds.height)return null;
    svg=original.cloneNode(true) as SVGSVGElement;svg.querySelector(":scope>g")?.removeAttribute("transform");
    const live=[original,...original.querySelectorAll("*")],copies=[svg,...svg.querySelectorAll("*")];
    for(let i=0;i<copies.length;i++){
      const style=getComputedStyle(live[i]);for(const key of ["font-family","font-size","font-weight","line-height","color","background-color","border","border-radius","padding","box-sizing","white-space","overflow-wrap","word-break","display","align-items","justify-content","fill","stroke","stroke-width"])(copies[i] as HTMLElement).style?.setProperty(key,style.getPropertyValue(key));
      if(copies[i].tagName.toLowerCase()==="input"||copies[i].tagName.toLowerCase()==="textarea"){const span=element("span",(live[i] as HTMLInputElement).value);span.setAttribute("style",copies[i].getAttribute("style")||"");copies[i].replaceWith(span);}
    }
    width=bounds.width+32;height=bounds.height+32;svg.setAttribute("viewBox",`${bounds.x-16} ${bounds.y-16} ${width} ${height}`);
  }else{
    const frame=rendered?.querySelector<HTMLIFrameElement>(".mermaid-stage iframe");if(!frame?.srcdoc)return null;
    svg=new DOMParser().parseFromString(frame.srcdoc,"text/html").querySelector("svg") as SVGSVGElement|null;if(!svg)return null;
    const box=svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);width=box?.[2]||800;height=box?.[3]||400;
  }
  svg.setAttribute("xmlns","http://www.w3.org/2000/svg");svg.setAttribute("width",String(width));svg.setAttribute("height",String(height));svg.style.maxWidth="none";
  svg.style.backgroundColor=document.documentElement.dataset.theme==="dark"?"#1b2230":"#ffffff";
  cleanSVG(svg);return {src:"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(new XMLSerializer().serializeToString(svg)),width,height};
}
const printCSS=`@page{size:A4;margin:18mm 17mm}html,body{margin:0;padding:0;background:#fff;color:#202733;color-scheme:light;font:11pt/1.6 "Noto Sans CJK SC","Microsoft YaHei","PingFang SC",Arial,sans-serif}body{overflow-wrap:anywhere}.export-title{font-size:24pt;line-height:1.3;margin:0 0 18pt}p{margin:0 0 8pt}li p[data-first-line-indent]{text-indent:0!important}h1,h2,h3,h4,h5{break-after:avoid;line-height:1.35;margin:15pt 0 8pt}h1{font-size:21pt}h2{font-size:18pt}h3{font-size:15pt}h4{font-size:13pt}h5{font-size:11pt}a{color:#254f9b;text-decoration:underline}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6;padding:8pt;font:9pt/1.5 Consolas,monospace}code{font-family:Consolas,monospace}blockquote{border-left:3pt solid #a0aec0;padding:3pt 10pt;margin:8pt 0;color:#4b5563}table{border-collapse:collapse;width:100%;table-layout:fixed;margin:8pt 0}th,td{border:1px solid #c8ced8;padding:5pt;vertical-align:top;overflow-wrap:anywhere}th{background:#f2f4f7}tr{break-inside:avoid}thead{display:table-header-group}figure{margin:10pt 0;max-width:100%;break-inside:avoid}figure img{max-width:100%;height:auto;max-height:245mm;object-fit:contain}figcaption{font-size:9pt;color:#667085}math[display="block"]{display:block;text-align:center;margin:10pt 0}img.diagram{display:block;max-width:100%;height:auto}ul,ol{padding-left:22pt}li>p{margin-bottom:4pt}.attachment-placeholder{color:#4b5563;border:1px solid #d8dee8;padding:7pt}.comparison-export td{border:0}.comparison-export img{width:100%;height:auto}hr{border:0;border-top:1px solid #c8ced8;margin:12pt 0}`;
export async function prepareNoteExport(source:ExportSource,title:string,serverURL:string){
  if(source.element.dataset.composing==="true")throw new Error(translateUI("请先完成当前输入，再导出笔记"));
  const diagrams=new Map<RichNode,Picture|null>(),formulae=new Map<string,Element>(),codeFragments=new Map<RichNode,Node[]>();
  const codeColors:Record<string,string>={"hljs-keyword":"#7c3bb0","hljs-selector-tag":"#7c3bb0","hljs-title":"#7c3bb0","hljs-string":"#216f41","hljs-attr":"#216f41","hljs-number":"#9c4c14","hljs-literal":"#9c4c14","hljs-comment":"#68778a"};
  function codeFragment(node:Node):Node {if(node.nodeType===Node.TEXT_NODE)return document.createTextNode(node.textContent||"");const span=element("span");if(node instanceof Element){for(const name of node.classList)if(codeColors[name])span.style.color=codeColors[name];if(node.classList.contains("hljs-comment"))span.style.fontStyle="italic";}for(const child of node.childNodes)span.append(codeFragment(child));return span;}
  for(const math of source.element.querySelectorAll(".katex-mathml math")){const latex=math.querySelector("annotation")?.textContent;if(latex!==undefined&&latex!==null)formulae.set(latex,math.cloneNode(true) as Element);}
  const capture=(node:RichNode)=>{if(node.type==="mindMap"||node.type==="codeBlock"&&node.attrs?.language==="mermaid")diagrams.set(node,diagramPicture(source.element,node));else if(node.type==="codeBlock"){const code=blockElement(source.element,node)?.querySelector("code");if(code?.textContent===text(node))codeFragments.set(node,[...code.childNodes].map(codeFragment));}for(const child of node.content||[])capture(child);};for(const node of source.snapshot.content)capture(node);
  await document.fonts?.ready;
  const started=Date.now();while(source.element.querySelector('.mermaid-preview [role="status"]')&&Date.now()-started<6000)await new Promise(resolve=>setTimeout(resolve,100));
  let encodedBytes=0;
  const root=element("main"),warnings:string[]=[],pictures=new Map<string,Promise<Picture|null>>();
  const imageTypes=new Map<string,Promise<boolean>>();
  root.append(element("h1",title));root.firstElementChild!.className="export-title";
  function math(node:RichNode){const latex=node.attrs?.latex||"",rendered=formulae.get(latex);if(rendered){const clone=rendered.cloneNode(true) as Element;clone.querySelectorAll("annotation").forEach(annotation=>annotation.remove());if(node.type==="mathBlock")clone.setAttribute("display","block");return clone;}return element("code",latex);}
  async function asset(id:unknown):Promise<Picture|null>{if(typeof id!=="string"||!/^[-\w]{1,80}$/.test(id))return null;if(!pictures.has(id))pictures.set(id,(async()=>{try{const response=await fetch(`/api/assets/${id}/file`,{credentials:"same-origin"});if(!response.ok)throw new Error(translateUI("无法读取图片"));const size=Number(response.headers.get("content-length")||0);if(size>maxImage)throw new Error(translateUI("图片超过导出上限"));const blob=await response.blob();if(blob.size>maxImage||!blob.type.startsWith("image/"))throw new Error(translateUI("图片格式无效"));const url=URL.createObjectURL(blob);try{const picture=await raster(url);encodedBytes+=picture.src.length;if(encodedBytes>24*1024*1024)throw new Error(translateUI("笔记图片过多"));return picture;}finally{URL.revokeObjectURL(url);}}catch{warnings.push(translateUI("部分图片未能嵌入，已保留附件链接"));return null;}})());return pictures.get(id)!;}
  function attachment(node:RichNode){const a=node.attrs||{},p=element("p");p.className="attachment-placeholder";const name=a.title||a.filename||({video:translateUI("视频"),audio:translateUI("音频"),pdf:translateUI("PDF 附件"),mesh:translateUI("三维工程"),gaussian:translateUI("三维数据")} as any)[a.kind]||translateUI("附件");const href=/^https?:\/\//.test(serverURL)&&/^[-\w]{1,80}$/.test(a.assetId||"")?`${serverURL.replace(/\/$/,"")}/api/assets/${a.assetId}/file`:null;if(href){const anchor=element("a",name);anchor.setAttribute("href",href);p.append(anchor,document.createTextNode(translateUI("（附件，访问需原笔记权限）")));}else p.textContent=translateUI("{0}（本地附件，请在原笔记中打开）", [name]);return p;}
  function img(picture:Picture){const node=document.createElement("img");node.src=picture.src;node.width=picture.width;node.height=picture.height;return node;}
  async function isImage(node:RichNode){
    const a=node.attrs||{};
    if(a.kind==="image"||String(a.mime||"").startsWith("image/")||blockElement(source.element,node)?.dataset.mediaKind==="image")return true;
    // Offscreen legacy SVG nodes have not been probed by the lazy viewer.
    // Inspect only headers during an explicit export, never download a large
    // generic attachment merely to determine whether it is an image.
    if(a.kind!=="file"||typeof a.assetId!=="string"||!/^[-\w]{1,80}$/.test(a.assetId))return false;
    if(!imageTypes.has(a.assetId))imageTypes.set(a.assetId,fetch(`/api/assets/${a.assetId}/file`,{method:"HEAD",credentials:"same-origin",signal:AbortSignal.timeout(15000)}).then(response=>response.ok&&!!response.headers.get("content-type")?.toLowerCase().startsWith("image/")).catch(()=>false));
    return imageTypes.get(a.assetId)!;
  }
  async function render(node:RichNode):Promise<Node>{
    const a=node.attrs||{};if(node.type==="text"){let result:Node=document.createTextNode(node.text||"");for(const mark of node.marks||[]){const tag=({bold:"strong",italic:"em",strike:"s",underline:"u",code:"code",link:"a"} as any)[mark.type]||"span",wrapper=element(tag);if(mark.type==="link"){const href=link(mark.attrs?.href||"",serverURL||location.href);if(href)wrapper.setAttribute("href",href);}if(mark.type==="textStyle"){if(hex(mark.attrs?.color))wrapper.style.color=mark.attrs!.color;const size=Number.parseFloat(mark.attrs?.fontSize);if(Number.isFinite(size)&&size>=8&&size<=96)wrapper.style.fontSize=size+"px";if(hex(mark.attrs?.backgroundColor))wrapper.style.backgroundColor=mark.attrs!.backgroundColor;}if(mark.type==="highlight"&&hex(mark.attrs?.color))wrapper.style.backgroundColor=mark.attrs!.color;wrapper.append(result);result=wrapper;}return result;}
    if(["mathBlock","inlineMath"].includes(node.type))return math(node);
    if(node.type==="hardBreak")return element("br");if(node.type==="horizontalRule")return element("hr");
    if(node.type==="mediaResource"){if(!await isImage(node))return attachment(node);const picture=await asset(a.assetId);if(!picture)return attachment(node);const figure=element("figure"),image=img(picture);image.alt=a.title||translateUI("图片");if(a.widthPercent!=null)image.style.width=a.widthPercent+"%";figure.style.textAlign=a.alignment||"left";figure.append(image);if(a.projection==="equirectangular")figure.append(element("figcaption",translateUI("360° 全景图片（平面展开）")));return figure;}
    if(node.type==="imageComparison"){const table=element("table"),body=element("tbody");table.className="comparison-export";table.append(body);let row=element("tr");body.append(row);for(const image of a.images||[]){if(a.orientation==="vertical"&&row.children.length){row=element("tr");body.append(row);}const cell=element("td"),picture=await asset(image.assetId);cell.append(picture?img(picture):attachment({type:"mediaResource",attrs:{...image,title:image.label,kind:"image"}}));row.append(cell);}if(a.caption){const container=element("div");container.append(table,element("p",String(a.caption)));return container;}return table;}
    if(node.type==="mindMap"||node.type==="codeBlock"&&a.language==="mermaid"){const rendered=blockElement(source.element,node),code=rendered?.querySelector("code")?.textContent;let picture=diagrams.get(node)||null;if(!picture&&node.type==="codeBlock"&&code===text(node))picture=diagramPicture(source.element,node);if(picture){const figure=element("figure"),image=img(picture);image.className="diagram";image.alt=node.type==="mindMap"?translateUI("思维导图"):translateUI("Mermaid 图表");figure.append(image);return figure;}warnings.push(translateUI("部分图表未就绪，已保留节点文字或源码"));if(node.type==="mindMap"){const list=element("ul");for(const item of node.content||[])list.append(element("li",text(item)));return list;}}
    const tag=({paragraph:"p",heading:"h"+Math.min(5,Math.max(1,Number(a.level)||1)),blockquote:"blockquote",bulletList:"ul",orderedList:"ol",taskList:"ul",taskItem:"li",listItem:"li",table:"table",tableRow:"tr",tableCell:"td",tableHeader:"th",codeBlock:"pre"} as any)[node.type]||"div",result=element(tag);
    if(["left","center","right","justify"].includes(a.textAlign))result.style.textAlign=a.textAlign;
    const indent=firstLineIndentCSS(node);if(indent){result.dataset.firstLineIndent="2";result.style.textIndent=indent;}
    if(node.type==="orderedList"&&a.start)result.setAttribute("start",String(a.start));if(node.type==="taskList")result.dataset.type="taskList";if(node.type==="taskItem")result.append(document.createTextNode(a.checked?"☑ ":"☐ "));
    if(tag==="td"||tag==="th"){if(a.colspan>1)result.setAttribute("colspan",String(a.colspan));if(a.rowspan>1)result.setAttribute("rowspan",String(a.rowspan));if(hex(a.background))result.style.backgroundColor=a.background;if(["top","middle","bottom"].includes(a.verticalAlign))result.style.verticalAlign=a.verticalAlign;if(Array.isArray(a.colwidth)&&a.colwidth.length&&a.colwidth.every((width:unknown)=>typeof width==="number"&&Number.isFinite(width)&&width>0)){result.style.width=a.colwidth.reduce((sum:number,width:number)=>sum+width,0)+"px";}}
    if(node.type==="codeBlock"){if(a.language)result.setAttribute("data-language",String(a.language));const code=element("code"),fragments=codeFragments.get(node);if(fragments)code.append(...fragments);else code.textContent=text(node);result.append(code);return result;}
    for(const child of node.content||[])result.append(await render(child));return result;
  }
  for(const node of source.snapshot.content)root.append(await render(node));
  const style=element("style",printCSS),page=document.implementation.createHTMLDocument(titleName(title));page.documentElement.lang="zh-CN";page.head.append(style);page.body.append(root);
  const policy=page.createElement("meta");policy.httpEquiv="Content-Security-Policy";policy.content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";page.head.prepend(policy);
  return {html:"<!doctype html>"+page.documentElement.outerHTML,root,warnings,title:titleName(title)};
}

let closePrintPreview:(()=>void)|null=null;
export async function exportNote(source:ExportSource,title:string,serverURL:string){
  const prepared=await prepareNoteExport(source,title,serverURL);
  if(window.anote?.exportNotePDF){const result=await window.anote.exportNotePDF({html:prepared.html,title:prepared.title});return result.saved?translateUI("PDF 已导出"):translateUI("已取消导出");}
  closePrintPreview?.();
  const frame=document.createElement("iframe");frame.title=translateUI("笔记打印预览");frame.dataset.notePrint="true";frame.style.cssText="position:fixed;width:794px;height:1123px;left:-10000px;top:0;border:0";document.body.append(frame);
  let restoreTitle:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const close=()=>{clearTimeout(timer);restoreTitle?.();frame.remove();if(closePrintPreview===close)closePrintPreview=null;};
  closePrintPreview=close;
  try{
    await new Promise<void>((resolve,reject)=>{frame.onload=()=>resolve();frame.onerror=()=>reject(new Error(translateUI("无法创建打印页面")));frame.srcdoc=prepared.html;});
    await frame.contentDocument?.fonts.ready;
    await Promise.all([...frame.contentDocument!.images].map(img=>img.decode().catch(()=>{})));
    if(closePrintPreview!==close)throw new Error(translateUI("打印预览已关闭，请重新导出"));
    const target=frame.contentWindow!;
    target.addEventListener("afterprint",close,{once:true});
    target.focus();
    restoreTitle=beginPrintTitle(prepared.title);
    timer=setTimeout(close,120000);
    target.print();
    return translateUI("已打开打印窗口，请选择“另存为 PDF”");
  }catch(error){close();throw error;}
}

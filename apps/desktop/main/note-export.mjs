import {BrowserWindow,dialog,app} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {noteAssetIds,noteExportTitle,prepareMarkdownArchive} from "@anote/sync-core/note-markdown";
import {writeMarkdownArchive} from "@anote/sync-core/note-archive";

const filename=value=>String(value||"未命名笔记").replace(/[\\/:*?"<>|\u0000-\u001f]/g,"_").slice(0,120).trim()||"未命名笔记";
export async function exportNoteMarkdown(window,input,options={}){
  if(typeof input?.content!=='string'||Buffer.byteLength(input.content)>8*1024*1024)throw new Error('Markdown 内容过大或无效');
  if(input.snapshot&&Buffer.byteLength(JSON.stringify(input.snapshot))>8*1024*1024)throw new Error('笔记内容过大');
  const assets=input.snapshot?noteAssetIds(input.snapshot,options.baseURL||''):[],extension=assets.length?'zip':'md';
  const result=await dialog.showSaveDialog(window,{title:assets.length?'导出 Markdown 和附件':'导出 Markdown',defaultPath:noteExportTitle(input.title)+'.'+extension,filters:[{name:assets.length?'Markdown 与附件归档':'Markdown 文档',extensions:[extension]}]});
  if(result.canceled||!result.filePath)return {saved:false};
  const temporary=result.filePath+'.'+randomUUID()+'.export';let handle;
  try{
    if(options.active&&!options.active())throw new Error('工作空间已切换，已取消导出');
    if(!assets.length)await fs.writeFile(temporary,input.content,{flag:'wx',mode:0o600});
    else {
      const plan=await prepareMarkdownArchive(input.snapshot,input.title,options.baseURL||'',options.metadata,Infinity,options.progress);
      handle=await fs.open(temporary,'wx',0o600);
      const sink=new WritableStream({write:chunk=>handle.writeFile(chunk),async close(){await handle.sync();await handle.close();handle=null;},async abort(){await handle?.close();handle=null;}});
      await writeMarkdownArchive(plan,sink,options.read,{progress:options.progress,active:options.active});
    }
    if(options.active&&!options.active())throw new Error('工作空间已切换，已取消导出');
    await fs.rename(temporary,result.filePath);return {saved:true,archive:!!assets.length};
  }finally{await handle?.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
}

async function save(window,name,bytes){
  const result=await dialog.showSaveDialog(window,{title:"导出 PDF",defaultPath:name,filters:[{name:"PDF 文档",extensions:["pdf"]}]});
  if(result.canceled||!result.filePath)return {saved:false};
  const temporary=result.filePath+"."+randomUUID()+".export";
  try{await fs.writeFile(temporary,bytes,{flag:"wx",mode:0o600});await fs.rename(temporary,result.filePath);}catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
  return {saved:true};
}
export async function exportNotePDF(window,input){
  if(typeof input?.html!=="string"||!input.html||Buffer.byteLength(input.html)>40*1024*1024)throw new Error("打印文档过大，请拆分笔记后导出");
  const directory=await fs.mkdtemp(path.join(app.getPath("temp"),"anote-print-")),file=path.join(directory,"note.html"),url=pathToFileURL(file).href;
  let preview;
  try{
    const policy="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'\">";
    await fs.writeFile(file,"<!doctype html><html><head>"+policy+"</head><body>"+input.html+"</body></html>",{mode:0o600});
    preview=new BrowserWindow({show:false,width:794,height:1123,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,javascript:false,webSecurity:true,partition:"anote-print-"+randomUUID()}});
    preview.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    preview.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:details.url!==url&&!details.url.startsWith("data:")}));
    preview.webContents.setWindowOpenHandler(()=>({action:"deny"}));
    preview.webContents.on("will-navigate",(event,target)=>{if(target!==url)event.preventDefault();});
    await preview.loadFile(file);
    const bytes=await preview.webContents.printToPDF({pageSize:"A4",printBackground:true,preferCSSPageSize:true});
    return await save(window,filename(input.title)+".pdf",bytes);
  }finally{if(preview&&!preview.isDestroyed())preview.destroy();await fs.rm(directory,{recursive:true,force:true});}
}

import type {MarkdownArchive} from './note-markdown.js';

/** Store media without recompressing it. The caller controls disk/blob output;
 * stream backpressure and ZIP64 keep desktop exports independent of RAM size. */
export async function writeMarkdownArchive(plan:MarkdownArchive,sink:WritableStream<Uint8Array>,read:(id:string)=>Promise<Response>,options:{progress?:(message:string)=>void;active?:()=>boolean;maxBytes?:number}={}){
  const {ZipWriter,TextReader}=await import('@zip.js/zip.js'),zip=new ZipWriter(sink,{level:0,useWebWorkers:false,preventClose:true,keepOrder:true}),active=()=>{if(options.active&&!options.active())throw new Error('工作空间已切换，已取消导出');};let total=0;
  try{
    active();await zip.add(plan.filename,new TextReader(plan.markdown));
    for(const [index,asset]of plan.assets.entries()){
      active();options.progress?.(`正在打包附件 ${index+1}/${plan.assets.length}：${asset.filename}`);
      const response=await read(asset.id);
      if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw new Error(`无法读取附件“${asset.filename}”（${response.status}），未生成不完整的归档`);}
      let bytes=0;
      const stream=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){active();bytes+=chunk.byteLength;total+=chunk.byteLength;if(total>(options.maxBytes??Infinity))throw new Error('附件超过当前浏览器的内存导出上限，请使用桌面客户端');controller.enqueue(chunk);},flush(){if(bytes!==asset.bytes)throw new Error(`附件“${asset.filename}”内容不完整，请重新导出`);}}));
      await zip.add(asset.path,stream,{uncompressedSize:asset.bytes});
    }
    active();await zip.close();const writer=sink.getWriter();try{await writer.close();}finally{writer.releaseLock();}
  }catch(error){await sink.abort(error).catch(()=>{});throw error;}
}

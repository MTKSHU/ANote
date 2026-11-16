import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {test,expect,type APIRequestContext} from "@playwright/test";
import {createHash,randomUUID} from "node:crypto";
import {Pool} from "pg";
import * as Y from "yjs";
import {initProseMirrorDoc,updateYFragment} from "@tiptap/y-tiptap";
import {schema} from "@anote/document-model";
import {api,login} from "./helpers";
import {person,grant,connect,call,upload as mcpUpload} from "./mcp-helpers";

const xml=`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><style>rect{fill:#e32127}</style><rect width="120" height="60"/><script>window.top.__svgExecuted=true</script></svg>`;
const svg=Buffer.from(xml),mime="image/svg+xml";
test.beforeEach(async({request})=>{
  expect(process.env.BASE_URL,"SVG tests only use the isolated fixture").toBe("http://anote.internal:3000");
  expect((await request.get("/api/platform/public").then(r=>r.json())).public_origin).toBe("http://anote.internal:3000");
});
async function fixture(request:APIRequestContext){
  const owner=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"SVG 验证"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"SVG 矢量图片"},owner);
  return {owner,book,note};
}
async function upload(request:APIRequestContext,owner:any,book:any,note:any,filename:string,buffer=svg){
  const hash=createHash("sha256").update(buffer).digest("hex"),task=await api(request,"POST","uploads",{space_id:book.id,doc_id:note.id,filename,hash,bytes:buffer.length},owner);
  const chunk=await request.put("/api/uploads/"+task.id+"/chunk",{headers:{Authorization:"Bearer "+owner.token,"Content-Type":"application/octet-stream","Upload-Offset":"0","X-Chunk-SHA256":hash},data:buffer});expect(chunk.status(),await chunk.text()).toBe(200);
  return api(request,"POST","uploads/"+task.id+"/complete",{},owner);
}
async function insert(request:APIRequestContext,owner:any,note:any,asset:any){
  const current=await api(request,"GET",`documents/${note.id}/offline`,undefined,owner),doc=new Y.Doc();
  try{Y.applyUpdate(doc,Buffer.from(current.ystate,"base64"));const fragment=doc.getXmlFragment("default"),pm=initProseMirrorDoc(fragment,schema);
    updateYFragment(doc,fragment,schema.nodeFromJSON({type:"doc",content:[{type:"mediaResource",attrs:{blockId:randomUUID(),assetId:asset.id,localPath:`assets/${asset.id}.svg`,src:asset.url,title:asset.filename,kind:"file",mime:"application/octet-stream",bytes:asset.bytes,hash:asset.hash}},{type:"paragraph",attrs:{blockId:randomUUID()}}]}),pm.meta);
    await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")},owner);
  }finally{doc.destroy();}
}

test("新上传 SVG 在正文、阅读、附件和匿名预览显示；样式正确且脚本不执行",async({page,request,browser})=>{
  const {owner,note}=await fixture(request);await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByLabel("上传附件文件",{exact:true}).setInputFiles({name:"styled-diagram.svg",mimeType:mime,buffer:svg});
  const image=page.locator('.media-resource[data-media-kind="image"] img');await expect(image).toHaveJSProperty("naturalWidth",120);await expect(image).toHaveJSProperty("naturalHeight",60);
  const pixels=await image.evaluate((element:HTMLImageElement)=>{const canvas=document.createElement("canvas");canvas.width=120;canvas.height=60;const context=canvas.getContext("2d")!;context.drawImage(element,0,0);return [...context.getImageData(50,30,1,1).data];});expect(pixels).toEqual([227,33,39,255]);
  await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存");
  const current=await api(request,"GET",`documents/${note.id}`,undefined,owner),attrs=current.snapshot.content.find((n:any)=>n.type==="mediaResource").attrs;expect(attrs.kind).toBe("image");expect(attrs.mime).toBe(mime);
  const asset=await api(request,"GET","assets/"+attrs.assetId,undefined,owner);expect(asset.jobs).toEqual([]);
  const response=await request.get(asset.url,{headers:{Authorization:"Bearer "+owner.token}});expect(response.headers()["content-type"]).toContain(mime);expect(response.headers()["content-security-policy"]).toBe("sandbox; default-src 'none'");expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  await image.dblclick();await expect(page.getByRole("dialog",{name:"媒体预览",exact:true}).locator("img")).toHaveJSProperty("naturalWidth",120);await page.keyboard.press("Escape");
  await page.evaluate(id=>window.dispatchEvent(new CustomEvent("anote-preview-asset",{detail:id})),asset.id);await expect(page.getByRole("dialog",{name:"附件预览",exact:true}).locator("img")).toHaveJSProperty("naturalWidth",120);await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"阅读",exact:true}).click();await image.click();await expect(page.getByRole("dialog",{name:"媒体预览",exact:true}).locator("img")).toHaveJSProperty("naturalWidth",120);await page.keyboard.press("Escape");
  expect(await page.evaluate(()=>(window as any).__svgExecuted)).toBeUndefined();
  const link=await api(request,"POST",`documents/${note.id}/sharing/links`,{},owner),context=await browser.newContext();try{const guest=await context.newPage();await guest.goto(new URL(link.path,page.url()).href);await expect(guest.locator(".media-resource img")).toHaveJSProperty("naturalWidth",120);expect(await guest.evaluate(()=>(window as any).__svgExecuted)).toBeUndefined();}finally{await context.close();}
  await page.screenshot({path:"artifacts/web/svg-image-support.png"});
});

test("历史 file/octet-stream SVG 自动显示和预览，匿名分享/离线导出兼容且不改写旧正文；HTML 伪装继续作为附件",async({page,request,browser})=>{
  await page.addInitScript(()=>{window.print=function(){if(window.frameElement?.hasAttribute('data-note-print'))(window.parent as any).__svgPrinted=true;};});
  const {owner,book,note}=await fixture(request),asset=await upload(request,owner,book,note,"legacy-diagram.svg");
  const connection=process.env.SVG_LEGACY_DATABASE_URL;expect(connection,"Legacy fixture mutation requires the isolated database URL").toBeTruthy();expect(new URL(connection!).hostname).toBe("db");
  const pool=new Pool({connectionString:connection});try{await pool.query("UPDATE assets SET kind='file',mime='application/octet-stream' WHERE id=$1 AND created_by=$2",[asset.id,owner.user.id]);}finally{await pool.end();}
  const repeated=await api(request,'POST',`uploads/${asset.id}/complete`,{},owner);expect(repeated.kind).toBe('image');expect(repeated.mime).toBe(mime);
  await insert(request,owner,note,asset);
  const before=await api(request,"GET",`documents/${note.id}`,undefined,owner);expect(before.snapshot.content[0].attrs.kind).toBe("file");
  await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.locator('.media-resource[data-media-kind="image"] img')).toHaveJSProperty("naturalWidth",120);
  await page.locator(".media-resource img").dblclick();await expect(page.getByRole("dialog",{name:"媒体预览",exact:true}).locator("img")).toHaveJSProperty("naturalWidth",120);await page.keyboard.press("Escape");
  await page.evaluate(id=>window.dispatchEvent(new CustomEvent("anote-preview-asset",{detail:id})),asset.id);await expect(page.getByRole("dialog",{name:"附件预览",exact:true}).locator("img")).toHaveJSProperty("naturalWidth",120);await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"笔记更多操作",exact:true}).click();await page.getByRole("button",{name:"打印／保存 PDF",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__svgPrinted)).toBe(true);
  const print=page.frameLocator('iframe[data-note-print="true"]');await expect(print.locator('figure img')).toHaveJSProperty('naturalWidth',120);await expect(print.locator('figure img')).toHaveAttribute('src',/^data:image\/png/);await expect(print.locator('.attachment-placeholder,script')).toHaveCount(0);
  await page.locator('iframe[data-note-print="true"]').evaluate(frame=>(frame as HTMLIFrameElement).contentWindow!.dispatchEvent(new Event('afterprint')));await expect(page.locator('iframe[data-note-print="true"]')).toHaveCount(0);
  const offline=await api(request,"GET",`documents/${note.id}/offline`,undefined,owner);expect(offline.assets[0].mime).toBe(mime);expect(offline.assets[0].kind).toBe("image");expect(offline.snapshot).toEqual(before.snapshot);
  const exported=await api(request,"GET",`documents/${note.id}/export`,undefined,owner);expect(exported.assets[0].mime).toBe(mime);
  const link=await api(request,"POST",`documents/${note.id}/sharing/links`,{},owner),context=await browser.newContext();try{const guest=await context.newPage();const privateRequests:string[]=[];guest.on("request",r=>{if(new URL(r.url()).pathname.startsWith("/api/assets/"))privateRequests.push(r.url());});await guest.goto(new URL(link.path,page.url()).href);await expect(guest.locator(".media-resource img")).toHaveJSProperty("naturalWidth",120);await guest.locator(".media-resource img").click();await expect(guest.getByRole("dialog",{name:"媒体预览",exact:true}).locator("img")).toHaveJSProperty("naturalWidth",120);expect(privateRequests).toEqual([]);}finally{await context.close();}
  const libraryLink=await api(request,'POST',`spaces/${book.id}/sharing/links`,{days:null},owner),libraryContext=await browser.newContext();try{
    const guest=await libraryContext.newPage();await guest.goto(new URL(libraryLink.path,page.url()).href);await expect(guest.locator('.media-resource img')).toHaveJSProperty('naturalWidth',120);await guest.locator('.media-resource img').click();await expect(guest.getByRole('dialog',{name:'媒体预览',exact:true}).locator('img')).toHaveJSProperty('naturalWidth',120);await guest.keyboard.press('Escape');
    const token=libraryLink.path.split('/').pop(),path=`/api/public/libraries/${token}/notes/${note.id}/assets/${asset.id}`;const original=await request.get(path);expect(original.headers()['content-type']).toContain(mime);
    await api(request,'DELETE',`spaces/${book.id}/sharing/links/${libraryLink.id}`,undefined,owner);expect((await request.get(path)).status()).toBe(404);await guest.reload();await expect(guest.getByRole('status')).toHaveText('知识库分享已失效');
  }finally{await libraryContext.close();}
  expect((await api(request,"GET",`documents/${note.id}`,undefined,owner)).snapshot).toEqual(before.snapshot);
  const disguised=await upload(request,owner,book,note,"html-disguised.svg",Buffer.from('<html><body><svg xmlns="http://www.w3.org/2000/svg"/></body></html>'));expect(disguised.kind).toBe("file");expect(disguised.mime).toBe("application/octet-stream");
  const outsider=await person(request),denied=await request.get(asset.url,{headers:{Authorization:"Bearer "+outsider.token}});expect(denied.status()).toBe(403);
});

test("MCP 上传 SVG 自动获得 image 标识，预览提交后可显示且不产生无用 FFmpeg 任务",async({page,request})=>{
  const {owner,book}=await fixture(request),access=await grant(request,owner),client=await connect(access.tokens.access_token);
  try{
    const staged=await mcpUpload(client,request,svg,{library_id:book.id},"MCP-vector.svg");expect(staged.kind).toBe("image");expect(staged.mime).toBe(mime);
    const preview=await call(client,"prepare_changes",{library_id:book.id,title:"MCP SVG 图片",schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:"insert",node:{type:"mediaResource",attrs:{assetId:staged.upload_id,kind:"file",mime:"application/octet-stream"}}}]});
    const media=preview.diff.find((item:any)=>item.after?.type==="mediaResource").after;expect(media.attrs.kind).toBe("image");expect(media.attrs.mime).toBe(mime);
    const result=await call(client,"apply_changes",{change_id:preview.change_id,preview_hash:preview.preview_hash,operation_id:randomUUID()});
    const asset=await api(request,"GET","assets/"+staged.upload_id,undefined,owner);expect(asset.kind).toBe("image");expect(asset.jobs).toEqual([]);
    const connection=process.env.SVG_LEGACY_DATABASE_URL;expect(connection).toBeTruthy();expect(new URL(connection!).hostname).toBe('db');const pool=new Pool({connectionString:connection});try{await pool.query("UPDATE assets SET kind='file',mime='application/octet-stream' WHERE id=$1 AND created_by=$2",[staged.upload_id,owner.user.id]);}finally{await pool.end();}
    const found=await call(client,'search_assets',{note_id:result.doc_id,query:'MCP-vector.svg'});expect(found.items).toHaveLength(1);expect(found.items[0].kind).toBe('image');expect(found.items[0].mime).toBe(mime);
    const read=await call(client,'read_asset',{asset_id:staged.upload_id});expect(read.info.kind).toBe('image');expect(read.info.mime).toBe(mime);
    await login(page,owner);await page.goto("/?doc="+result.doc_id);await expect(page.locator(".media-resource img")).toHaveJSProperty("naturalWidth",120);
  }finally{await client.close();await access.close();}
});

test("历史 SVG 图片/文件筛选正确填充分页，伪装HTML不混入图片，扫描上限保留可续用cursor",async({request})=>{
  const {owner,book,note}=await fixture(request),vector=await upload(request,owner,book,note,"paging-source.svg"),html=await upload(request,owner,book,note,"paging-html.svg",Buffer.from('<html><body><svg xmlns="http://www.w3.org/2000/svg"/></body></html>'));
  const connection=process.env.SVG_LEGACY_DATABASE_URL;expect(connection).toBeTruthy();expect(new URL(connection!).hostname).toBe("db");
  const pool=new Pool({connectionString:connection}),prefix="svg-paging-basic-"+randomUUID(),bounded="svg-paging-bounded-"+randomUUID(),rows:any[]=[];
  const append=(scope:string,count:number,source:string,suffix:string)=>{for(let i=0;i<count;i++){const id=randomUUID();rows.push({id,source,filename:scope+'-'+rows.length+suffix,title:scope,created_at:new Date(Date.now()-rows.length*1000).toISOString()});}};
  append(prefix,4,html.id,".svg");append(prefix,43,vector.id,".SVG");append(prefix,3,html.id,".bin");append(bounded,1020,html.id,".svg");append(bounded,1,vector.id,".svg");
  try{await pool.query(`INSERT INTO assets(id,space_id,created_by,filename,title,mime,bytes,hash,storage_key,kind,metadata,status,owner_doc_id,created_at)
    SELECT f.id,a.space_id,a.created_by,f.filename,f.title,'application/octet-stream',a.bytes,a.hash,a.storage_key,'file',a.metadata,'ready',a.owner_doc_id,f.created_at
    FROM jsonb_to_recordset($1::jsonb) AS f(id text,source text,filename text,title text,created_at timestamptz) JOIN assets a ON a.id=f.source WHERE a.created_by=$2`,[JSON.stringify(rows),owner.user.id]);}finally{await pool.end();}
  const query=`documents/${note.id}/assets/search?q=${prefix}&kind=image`,first=await api(request,"GET",query,undefined,owner);expect(first.items).toHaveLength(40);expect(first.nextOffset).toBe(44);expect(first.items.every((item:any)=>item.kind==="image"&&item.mime===mime)).toBe(true);
  const second=await api(request,"GET",query+"&offset="+first.nextOffset,undefined,owner);expect(second.items).toHaveLength(3);expect(second.nextOffset).toBeNull();expect(new Set([...first.items,...second.items].map((item:any)=>item.id)).size).toBe(43);
  const files=await api(request,"GET",`documents/${note.id}/assets/search?q=${prefix}&kind=file`,undefined,owner);expect(files.items).toHaveLength(7);expect(files.nextOffset).toBeNull();expect(files.items.every((item:any)=>item.kind==="file"&&item.mime==="application/octet-stream")).toBe(true);
  const listed=await api(request,"GET",`assets?space_id=${book.id}&q=${prefix}&kind=image`,undefined,owner);expect(listed).toHaveLength(43);
  const short=await api(request,"GET",`documents/${note.id}/assets/search?q=${bounded}&kind=image`,undefined,owner);expect(short.items).toEqual([]);expect(short.nextOffset).toBe(512);
  const resumed=await api(request,"GET",`documents/${note.id}/assets/search?q=${bounded}&kind=image&offset=${short.nextOffset}`,undefined,owner);expect(resumed.items).toHaveLength(1);expect(resumed.items[0].id).toBe(rows.at(-1).id);expect(resumed.nextOffset).toBeNull();
  const listPath=`/api/assets?space_id=${book.id}&q=${bounded}&kind=image`,headers={Authorization:"Bearer "+owner.token},partial=await request.get(listPath,{headers});expect(partial.status()).toBe(200);expect(await partial.json()).toEqual([]);expect(partial.headers()["x-next-offset"]).toBe("1000");
  const continued=await request.get(listPath+"&offset="+partial.headers()["x-next-offset"],{headers});expect(continued.status()).toBe(200);const remaining=await continued.json();expect(remaining).toHaveLength(1);expect(remaining[0].id).toBe(rows.at(-1).id);expect(continued.headers()["x-next-offset"]).toBeUndefined();
  expect((await request.get(listPath+"&offset=-1",{headers})).status()).toBe(400);
});

import {test,expect,type APIRequestContext} from '@playwright/test';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {api,login} from './helpers';
import {person} from './mcp-helpers';

async function fixture(request:APIRequestContext){
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'按需媒体验证'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'大笔记中的图片与声音'},owner);
  return {owner,book,note};
}
async function upload(request:APIRequestContext,f:any,filename:string,bytes:Buffer){
  const hash=createHash('sha256').update(bytes).digest('hex'),task=await api(request,'POST','uploads',{space_id:f.book.id,doc_id:f.note.id,filename,bytes:bytes.length,hash},f.owner);
  const response=await request.put(`/api/uploads/${task.id}/chunk`,{headers:{Authorization:'Bearer '+f.owner.token,'Content-Type':'application/octet-stream','Upload-Offset':'0','X-Chunk-SHA256':hash},data:bytes});expect(response.status(),await response.text()).toBe(200);
  return api(request,'POST',`uploads/${task.id}/complete`,{},f.owner);
}
const paragraph=(text:string)=>({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]}),media=(asset:any,overrides={})=>({type:'mediaResource',attrs:{blockId:randomUUID(),assetId:asset.id,src:asset.url,title:asset.filename,kind:asset.kind,mime:asset.mime,bytes:asset.bytes,hash:asset.hash,...overrides}});
function wav(){
  const samples=16000*3,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*2000),44+i*2);return bytes;
}

test('长笔记先显示正文，离屏图片不请求，滚动才加载且不改协作正文',async({page,request})=>{
  await page.addInitScript(()=>{window.print=function(){if(window.frameElement?.hasAttribute('data-note-print'))(window.parent as any).__lazyPrinted=true;};});
  const f=await fixture(request),images=[];
  for(let i=0;i<24;i++)images.push(await upload(request,f,`long-note-${i}.svg`,Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#dbeafe"/><text x="20" y="40">Image ${i}</text></svg>`)));
  const video=await upload(request,f,'按需视频.mp4',await fs.readFile('artifacts/server/fixtures/sample.mp4'));
  await login(page,f.owner);await page.goto('/?doc='+f.note.id);const editor=page.getByTestId('editor');await expect(editor).toBeVisible();
  const content=[...Array.from({length:90},(_,i)=>paragraph('先阅读文字 '+i)),media(video),...images.map((asset,index)=>media(asset,index===23?{kind:'file',mime:'application/octet-stream'}:{})),paragraph('文末仍可编辑')];
  await editor.evaluate((element,content)=>(element as any).editor.commands.setContent({type:'doc',content}),content);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');
  const before=await api(request,'GET',`documents/${f.note.id}`,undefined,f.owner),requested=new Set<string>();
  let videoRequests=0;page.on('request',request=>{if(request.method()!=='GET')return;const pathname=new URL(request.url()).pathname;if(images.some(asset=>pathname===asset.url))requested.add(pathname);if(pathname===video.url)videoRequests++;});
  await page.reload();await expect(editor).toContainText('先阅读文字 0');await expect(editor.locator('.media-resource')).toHaveCount(25);
  await page.waitForTimeout(350);expect(requested.size).toBe(0);expect(videoRequests).toBe(0);
  const videoFrame=editor.locator('.media-resource[data-media-kind="video"]');await videoFrame.scrollIntoViewIfNeeded();await expect.poll(()=>videoFrame.locator('video').evaluate(element=>element.videoWidth)).toBeGreaterThan(0);expect(videoRequests).toBeGreaterThan(0);
  const first=editor.locator('.media-resource[data-media-kind="image"]').first();await first.scrollIntoViewIfNeeded();await expect(first.locator('img')).toHaveJSProperty('naturalWidth',640);
  expect(requested.size).toBeGreaterThan(0);expect(requested.size).toBeLessThan(images.length);
  await expect(editor.locator('.media-resource[data-media-loaded="false"]')).not.toHaveCount(0);
  const last=editor.locator('.media-resource').last();await expect(last).toHaveAttribute('data-media-loaded','false');
  await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();await page.getByRole('button',{name:'打印／保存 PDF',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__lazyPrinted)).toBe(true);
  const print=page.frameLocator('iframe[data-note-print="true"]');await expect(print.locator('figure img')).toHaveCount(24);await expect(print.getByAltText('long-note-23.svg')).toHaveAttribute('src',/^data:image\/png/);
  await expect(last).toHaveAttribute('data-media-loaded','false');await page.locator('iframe[data-note-print="true"]').evaluate(frame=>(frame as HTMLIFrameElement).contentWindow!.dispatchEvent(new Event('afterprint')));await expect(page.locator('iframe[data-note-print="true"]')).toHaveCount(0);
  await last.scrollIntoViewIfNeeded();await expect(last.locator('img')).toHaveJSProperty('naturalWidth',640);
  expect((await api(request,'GET',`documents/${f.note.id}`,undefined,f.owner)).snapshot).toEqual(before.snapshot);
  await page.screenshot({path:'artifacts/preview-051/web/lazy-media.png',animations:'disabled'});
});

test('旧 file 标识音频仅显示居中控件，悬停显示文件名、双击展开且播放不改正文',async({page,request,browser})=>{
  const f=await fixture(request),asset=await upload(request,f,'可播放录音.wav',wav());expect(asset.kind).toBe('audio');expect(asset.mime).toBe('audio/wav');
  await login(page,f.owner);await page.goto('/?doc='+f.note.id);const editor=page.getByTestId('editor');await expect(editor).toBeVisible();
  await editor.evaluate((element,content)=>(element as any).editor.commands.setContent({type:'doc',content}),[media(asset,{kind:'file',mime:'audio/wav'}),paragraph('录音说明')]);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');
  const before=await api(request,'GET',`documents/${f.note.id}`,undefined,f.owner),audio=editor.locator('audio'),controls=editor.getByRole('group',{name:'音频播放控件',exact:true});expect(before.snapshot.content[0].attrs.kind).toBe('file');await expect(controls).toBeVisible();await expect(audio).toBeHidden();await expect(audio).toHaveAttribute('preload','none');await expect(audio).toHaveJSProperty('controls',false);
  await controls.getByRole('button',{name:'播放音频',exact:true}).click();
  await expect.poll(()=>audio.evaluate(element=>({duration:(element as HTMLAudioElement).duration,paused:(element as HTMLAudioElement).paused}))).toEqual({duration:3,paused:false});
  await controls.getByRole('button',{name:'暂停音频',exact:true}).click();await expect(audio).toHaveJSProperty('paused',true);
  const progress=controls.getByRole('slider',{name:'音频播放进度',exact:true});await expect(progress).toBeEnabled();await progress.press('Home');await progress.press('ArrowRight');await expect.poll(()=>audio.evaluate(element=>(element as HTMLAudioElement).currentTime)).toBeCloseTo(.1);
  await controls.getByRole('slider',{name:'音量',exact:true}).press('Home');await expect(audio).toHaveJSProperty('volume',0);await controls.getByRole('button',{name:'取消静音',exact:true}).click();await expect(audio).toHaveJSProperty('volume',1);
  await expect(controls).toHaveAttribute('title','可播放录音.wav');
  await expect(editor.locator('.inline-audio-heading')).toHaveCount(0);await expect(editor.getByRole('link',{name:'下载音频 可播放录音.wav'})).toHaveCount(0);await expect(editor.getByRole('button',{name:'展开音频播放器'})).toHaveCount(0);
  const layout=await controls.evaluate(element=>{const player=element.getBoundingClientRect(),container=element.parentElement!,box=container.getBoundingClientRect(),style=getComputedStyle(container);return {centerOffset:Math.abs(player.left+player.width/2-box.left-box.width/2),border:style.borderTopWidth,padding:style.paddingTop,background:style.backgroundColor};});expect(layout.centerOffset).toBeLessThan(1);expect(layout).toMatchObject({border:'0px',padding:'0px',background:'rgba(0, 0, 0, 0)'});
  await controls.hover();await controls.dblclick();await expect(page.getByRole('dialog',{name:'媒体预览',exact:true}).getByLabel('音频播放器',{exact:true})).toBeVisible();await expect(audio).toHaveJSProperty('paused',true);await page.keyboard.press('Escape');
  await controls.focus();await page.keyboard.press('Alt+Enter');await expect(page.getByRole('dialog',{name:'媒体预览',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  const link=await api(request,'POST',`documents/${f.note.id}/sharing/links`,{},f.owner),context=await browser.newContext();
  try{const guest=await context.newPage(),privateRequests:string[]=[];guest.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/assets/'))privateRequests.push(request.url());});await guest.goto(new URL(link.path,page.url()).href);const player=guest.locator('audio'),bar=guest.getByRole('group',{name:'音频播放控件',exact:true});await expect(bar).toBeVisible();await expect(player).toHaveAttribute('src',/\/api\/public\//);await expect(bar).toHaveAttribute('title','可播放录音.wav');await bar.getByRole('button',{name:'播放音频',exact:true}).click();await expect(player).toHaveJSProperty('paused',false);await bar.dblclick();await expect(guest.getByRole('dialog',{name:'媒体预览',exact:true}).locator('audio')).toBeVisible();expect(privateRequests).toEqual([]);}finally{await context.close();}
  expect((await api(request,'GET',`documents/${f.note.id}`,undefined,f.owner)).snapshot).toEqual(before.snapshot);
});

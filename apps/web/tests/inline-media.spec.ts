import {test,expect,type Locator} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin,login,chooseTheme} from "./helpers";
async function cleanFrames(scope:Locator){
  const frames=scope.locator('.media-resource');await expect(frames).toHaveCount(3);
  for(const frame of await frames.all()){
    await expect(frame).toHaveCSS('border-top-width','0px');await expect(frame).toHaveCSS('padding','0px');await expect(frame).toHaveCSS('border-radius','0px');await expect(frame).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
    await expect(frame.locator('figcaption,.attachment-details,.inline-attachment')).toHaveCount(0);expect((await frame.locator('img,video,audio').count())).toBe(1);
  }
  for(const kind of ['video','audio'])await expect(scope.locator('.media-resource '+kind)).toHaveJSProperty('controls',true);
}
async function setup(page:any,request:any){
  const root=await admin(request),username='media-'+randomUUID().slice(0,8),password='Direct-media-test-123!';await api(request,'POST','users',{username,password,name:'媒体展示验证'},root);const owner={...await api(request,'POST','auth/login',{username,password}),username,password};const library=await api(request,'POST','spaces',{kind:'personal',name:'媒体笔记'},owner),note=await api(request,'POST','documents',{space_id:library.id,title:'正文直接呈现媒体'},owner);
  await login(page,owner);await page.goto('/?doc='+note.id);await expect(page.getByTestId('editor')).toBeVisible();await page.getByLabel('上传附件文件',{exact:true}).setInputFiles(['sample.png','sample.mp4','sample.wav'].map(name=>'artifacts/server/fixtures/'+name));await expect(page.locator('.media-resource')).toHaveCount(3);await expect(page.locator('.media-resource img')).toHaveJSProperty('naturalWidth',64);await expect(page.getByTestId('document-sync')).toHaveText('已同步');return{owner,note};
}
test('图片视频音频直接渲染，明暗主题及阅读模式没有外框、文件名和底部按钮，图片可点击与键盘放大',async({page,request})=>{
  const{owner,note}=await setup(page,request);for(const theme of ['light','dark'] as const){await chooseTheme(page,theme);await expect(page.locator('html')).not.toHaveClass(/theme-changing/);await cleanFrames(page.getByTestId('editor'));await page.locator('.document-actions').getByRole('button',{name:'阅读',exact:true}).click();await cleanFrames(page.getByTestId('editor'));await page.screenshot({path:`artifacts/web/inline-media-${theme}.png`,animations:'disabled'});
    const image=page.getByRole('button',{name:'查看图片 sample.png',exact:true});await image.click();const preview=page.getByRole('dialog',{name:'媒体预览',exact:true});await expect(preview.locator('img')).toHaveJSProperty('naturalWidth',64);await page.keyboard.press('Escape');await expect(preview).toHaveCount(0);await expect(image).toBeFocused();await image.press('Enter');await expect(preview).toBeVisible();await page.keyboard.press('Escape');await page.locator('.document-actions').getByRole('button',{name:'编辑',exact:true}).click();}
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');const exported=await api(request,'GET',`documents/${note.id}/export`,undefined,owner);for(const filename of ['sample.png','sample.mp4','sample.wav'])expect(exported.markdown).toContain(filename);await page.reload();await cleanFrames(page.getByTestId('editor'));
});
test('匿名共享中的图片视频音频也直接渲染并保留原生播放控件，两个主题不泄露私有预览入口',async({page,request,browser})=>{
  const{owner,note}=await setup(page,request),link=await api(request,'POST',`documents/${note.id}/sharing/links`,{},owner);
  for(const theme of ['light','dark'] as const){const context=await browser.newContext({colorScheme:theme});try{const guest=await context.newPage();const privateRequests:string[]=[];guest.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/assets/'))privateRequests.push(request.url());});await guest.goto(new URL(link.path,page.url()).href);await expect(guest.getByTestId('editor')).toHaveAttribute('contenteditable','false');await expect(guest.locator('html')).toHaveAttribute('data-theme',theme);await expect(guest.locator('.media-resource img')).toHaveJSProperty('naturalWidth',64);await cleanFrames(guest.getByTestId('editor'));await guest.locator('.media-resource img').click();await expect(guest.getByRole('dialog',{name:'媒体预览',exact:true}).locator('img')).toHaveJSProperty('naturalWidth',64);await guest.keyboard.press('Escape');expect(privateRequests).toEqual([]);}finally{await context.close();}}
});

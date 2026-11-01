import {test,expect,type Locator} from '@playwright/test';
import {api,login,slash,chooseTheme} from './helpers';
import {person} from './mcp-helpers';
async function sample(canvas:Locator){
  const png=await canvas.screenshot({animations:'disabled'});
  return canvas.page().evaluate(async base64=>{
    const img=new Image();img.src='data:image/png;base64,'+base64;await img.decode();const el=document.createElement('canvas');el.width=img.width;el.height=img.height;const ctx=el.getContext('2d')!;ctx.drawImage(img,0,0);
    const x=Math.floor(img.width*.75),y=40,semiY=y+20*Math.ceil((img.height*.65-y)/20),at=(x:number,y:number)=>[...ctx.getImageData(x,y,1,1).data];
    return {before:at(Math.floor(img.width*.25),y),transparent:at(x,y),semi:at(x,semiY),left:at(Math.floor(img.width*.25),semiY)};
  },png.toString('base64'));
}
test('双图独立裁切：Alpha 不透出另一张图，半透明与棋盘格正确合成，滑动缩放保留原图',async({page,request})=>{
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'透明图比较'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'Alpha 比较'},owner);
  await login(page,owner);await page.goto('/?doc='+note.id);await expect(page.getByTestId('editor')).toBeVisible();
  const images=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const ctx=canvas.getContext('2d')!;
    ctx.fillStyle='#ff0000';ctx.fillRect(0,0,64,36);const before=canvas.toDataURL().split(',')[1];ctx.clearRect(0,0,64,36);ctx.fillStyle='rgba(0,0,255,0.5)';ctx.fillRect(0,18,64,18);return {before,after:canvas.toDataURL().split(',')[1]};
  });
  await slash(page,'双图对比');await page.getByLabel('上传附件文件',{exact:true}).setInputFiles([{name:'before-red.png',mimeType:'image/png',buffer:Buffer.from(images.before,'base64')},{name:'after-alpha.png',mimeType:'image/png',buffer:Buffer.from(images.after,'base64')}]);
  const comparison=page.getByTestId('image-comparison'),canvas=comparison.locator('.comparison-canvas');await expect(comparison.locator('img').last()).toHaveJSProperty('naturalWidth',64);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');await page.locator('.document-actions').getByRole('button',{name:'阅读',exact:true}).click();
  const hash=(await api(request,'GET',`documents/${note.id}`,undefined,owner)).hash;
  for(const theme of ['light','dark'] as const){
    await chooseTheme(page,theme);await expect(page.locator('html')).not.toHaveClass(/theme-changing/);const pixels=await sample(canvas);expect(pixels.before.slice(0,3)).toEqual([255,0,0]);expect(pixels.left.slice(0,3)).toEqual([255,0,0]);
    expect(pixels.transparent[1]).toBeGreaterThan(theme==='light'?200:15);expect(Math.abs(pixels.transparent[0]-pixels.transparent[1])).toBeLessThan(25);
    const alpha=128/255;for(let c=0;c<3;c++){const expected=pixels.transparent[c]*(1-alpha)+(c===2?255:0)*alpha;expect(Math.abs(pixels.semi[c]-expected)).toBeLessThan(3);}
    await canvas.screenshot({path:`artifacts/web/alpha-comparison-${theme}.png`});
  }
  const rect=(await canvas.boundingBox())!;
  await page.mouse.move(rect.x+1,rect.y+50);await page.mouse.down();await page.mouse.up();await expect.poll(async()=>Number(await canvas.getAttribute('aria-valuenow'))).toBeLessThan(1);let pixels=await sample(canvas);expect(pixels.before[1]).toBeGreaterThan(15);
  await page.mouse.move(rect.x+rect.width-1,rect.y+50);await page.mouse.down();await page.mouse.up();await expect.poll(async()=>Number(await canvas.getAttribute('aria-valuenow'))).toBeGreaterThan(99);pixels=await sample(canvas);expect(pixels.transparent.slice(0,3)).toEqual([255,0,0]);
  await comparison.getByRole('button',{name:'放大对比图片',exact:true}).click();await expect(comparison.locator('.comparison-controls')).toContainText('125%');
  expect((await api(request,'GET',`documents/${note.id}`,undefined,owner)).hash).toBe(hash);
  const src=await comparison.locator('img').last().getAttribute('src');expect((await page.request.get(src!)).ok()).toBe(true);expect((await (await page.request.get(src!)).body()).equals(Buffer.from(images.after,'base64'))).toBe(true);
});

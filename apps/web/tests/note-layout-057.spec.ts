import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {test,expect,type Page,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema,canonical} from '@anote/document-model';
import {api,login} from './helpers';
import {person} from './mcp-helpers';

test.beforeEach(async({browserName,browser},info)=>{expect(browserName).toBe(info.project.name.endsWith('webkit')?'webkit':'chromium');info.annotations.push({type:'browser',description:browserName+' '+browser.version()});});
test.beforeAll(async({request})=>{expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');expect(['http://127.0.0.1:3210','http://127.0.0.1:3220']).toContain((await api(request,'GET','platform/public')).public_origin);});
async function open(page:Page,request:APIRequestContext){
  const owner=await person(request),book=await api(request,'POST','spaces',{name:'057 layout QA',kind:'personal'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'标题对齐与移动浮窗'},owner),block=(type:string,text:string,level?:number)=>({type,attrs:{blockId:randomUUID(),...(level?{level}:{})},content:[{type:'text',text}]}),snapshot=canonical({type:'doc',content:Array.from({length:50},(_,i)=>[block('heading','章节 '+(i+1)+(i===2?'：用于验证换行后标题仍然与正文对齐的较长标题文字':''),i%5+1),block('paragraph','章节正文 '+(i+1)+'，用于验证完整笔记滚动而非仅改变滚动属性。')]).flat()}),doc=prosemirrorJSONToYDoc(schema,snapshot,'default');
  try{await api(request,'POST',`documents/${note.id}/offline-sync`,{migrationEncoding:2,schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')},owner);}finally{doc.destroy();}
  await login(page,owner);await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('editor')).toBeVisible();return {owner,note};
}
async function panelOpen(page:Page,name:string,isMobile:boolean){
  if(isMobile){await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();await page.getByRole('button',{name,exact:true}).click();}
  else await page.getByRole('button',{name:name==='文内目录'?'显示文内目录':name,exact:true}).click();
  return page.getByRole('complementary',{name,exact:true});
}
test('heading text stays aligned with body text and gutter controls remain independently clickable',async({page,request,isMobile},info)=>{
  await open(page,request);const editor=page.getByTestId('editor');
  for(const size of isMobile?[{width:393,height:851},{width:320,height:640},{width:844,height:390}]:[{width:1580,height:1000},{width:1080,height:760}]){
    await page.setViewportSize(size);await page.locator('.document-region:visible').evaluate(el=>el.scrollTop=0);
    for(const level of [1,2,3,4,5]){
      const heading=editor.locator('h'+level).first();await heading.scrollIntoViewIfNeeded();
      const geometry=await heading.evaluate(el=>{const text=Array.from(el.childNodes).find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent?.trim())!;const r=document.createRange();r.selectNodeContents(text);const rect=r.getBoundingClientRect(),body=el.nextElementSibling!.getBoundingClientRect(),button=el.querySelector('button')!.getBoundingClientRect();return {text:rect.x,body:body.x,buttonLeft:button.x,buttonRight:button.right};});
      expect(Math.abs(geometry.text-geometry.body)).toBeLessThanOrEqual(1);expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.text);expect(geometry.buttonLeft).toBeGreaterThanOrEqual(0);
    }
  }
  await page.setViewportSize(isMobile?{width:393,height:851}:{width:1450,height:900});if(isMobile)await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.document-region:visible').evaluate(el=>el.scrollTop=0);const heading=editor.locator('h1').first();await heading.click();
  const fold=heading.getByRole('button',{name:'折叠“章节 1”的内容',exact:true}),format=page.getByRole('button',{name:'段落格式：标题 1',exact:true});await expect(format).toBeVisible();
  for(const control of [fold,format])expect(await control.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
  await format.click();await expect(page.getByRole('menu',{name:'段落格式',exact:true})).toBeVisible();await page.keyboard.press('Escape');await fold.click();await expect(editor.getByText('章节正文 1，用于验证完整笔记滚动而非仅改变滚动属性。',{exact:true})).toBeHidden();
  await page.screenshot({path:info.outputPath('heading-gutter.png')});
});
for(const name of ['文内目录','历史版本'])test(name+' remains on the right throughout long note scrolling and viewport changes',async({page,request,isMobile},info)=>{
  await open(page,request);const panel=await panelOpen(page,name,isMobile),region=page.locator('.document-region:visible');await expect(panel).toBeVisible();
  const sizes=isMobile?[{width:393,height:851},{width:393,height:700},{width:320,height:640},{width:844,height:390}]:[{width:1580,height:1000},{width:1080,height:760}];
  for(const size of sizes){
    await page.setViewportSize(size);
    for(const ratio of [0,.45,.96,0]){
      await region.evaluate((el,r)=>el.scrollTop=(el.scrollHeight-el.clientHeight)*r,ratio);if(ratio>0)await expect.poll(()=>region.evaluate(el=>el.scrollTop)).toBeGreaterThan(500);
      await expect.poll(()=>panel.evaluate(el=>{const r=el.getBoundingClientRect(),header=document.querySelector('.document-region:not([aria-hidden="true"]) .document-header')!.getBoundingClientRect(),info=document.querySelector('.document-region:not([aria-hidden="true"]) .document-info')!.getBoundingClientRect();return r.height>40&&Math.abs(r.top-Math.max(0,header.bottom,info.bottom)-8)<=1&&r.bottom<=innerHeight-6&&r.right<=innerWidth&&r.right>=innerWidth-24;})).toBe(true);
      const close=panel.getByRole('button',{name:name==='文内目录'?'隐藏文内目录':'收起侧栏',exact:true});expect(await close.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
    }
  }
  if(name==='文内目录'){const nav=panel.locator('nav');await nav.evaluate(el=>el.scrollTop=el.scrollHeight);await expect.poll(()=>nav.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);await expect(panel.getByRole('button',{name:'隐藏文内目录',exact:true})).toBeVisible();}
  // Opening another action while a floating panel is visible must not put
  // the toolbar's popup behind the panel's stacking context.
  await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();const menu=page.locator('.note-more[open]>div');await expect(menu).toBeVisible();for(const button of await menu.locator('button:visible').all()){await button.scrollIntoViewIfNeeded();expect(await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);}await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();
  await page.screenshot({path:info.outputPath('floating-panel.png')});await panel.getByRole('button',{name:name==='文内目录'?'隐藏文内目录':'收起侧栏',exact:true}).click();await expect(panel).toHaveCount(0);
});

import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema,canonical,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {api,login} from './helpers';
import {person} from './mcp-helpers';
import fs from 'node:fs/promises';

test.beforeAll(async({request})=>{expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');expect(['http://127.0.0.1:3210','http://127.0.0.1:3220']).toContain((await api(request,'GET','platform/public')).public_origin);});
async function fixture(request:APIRequestContext){
  const owner=await person(request),book=await api(request,'POST','spaces',{name:'056 long note',kind:'personal'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'长文导出与折叠测试'},owner);
  const block=(type:string,text:string,level?:number)=>({type,attrs:{blockId:randomUUID(),...(level?{level}:{})},content:[{type:'text',text}]}),snapshot=canonical({type:'doc',content:[block('heading','第一章',1),block('paragraph','第一章正文'),block('heading','子章节',2),block('paragraph','子章节正文'),block('heading','更深章节',3),block('paragraph','更深章节正文'),{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'下划线与彩色内容',marks:[{type:'underline'},{type:'textStyle',attrs:{color:'#336699'}}]},{type:'text',text:'加粗内容',marks:[{type:'bold'}]}]},{type:'taskList',attrs:{blockId:randomUUID()},content:[{type:'taskItem',attrs:{checked:true},content:[block('paragraph','已完成的待办')]}]},{type:'codeBlock',attrs:{blockId:randomUUID(),language:'text'},content:[{type:'text',text:'sample code'}]},{type:'blockquote',attrs:{blockId:randomUUID()},content:[block('paragraph','引用正文：结构化版本也应该完整保留')]},block('heading','第二章',1),...Array.from({length:40},(_,i)=>block('paragraph','第二章较长的内容，第 '+i+' 行。阅读滚动测试。'))]}),document=prosemirrorJSONToYDoc(schema,snapshot,'default');
  try{await api(request,'POST',`documents/${note.id}/offline-sync`,{migrationEncoding:2,schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')},owner);}finally{document.destroy();}
  return {owner,note,snapshot};
}
const editor=(page:Page)=>page.getByTestId('editor');
const fold=(page:Page,title:string)=>editor(page).getByRole('button',{name:`折叠“${title}”的内容`,exact:true});
async function open(page:Page,request:APIRequestContext){const f=await fixture(request);await login(page,f.owner);await page.goto('/?scope=personal&doc='+f.note.id);await expect(editor(page)).toBeVisible();return f;}

test('heading sections fold by hierarchy, retain nested folds, and export all Markdown without modifying content',async({page,request,isMobile})=>{
  const f=await open(page,request),before=await api(request,'GET',`documents/${f.note.id}`,undefined,f.owner);
  await fold(page,'子章节').click();await expect(editor(page).getByText('子章节正文',{exact:true})).toBeHidden();await expect(editor(page).getByRole('heading',{name:'更深章节',exact:true})).toBeHidden();await expect(editor(page).getByRole('heading',{name:'第二章',exact:true})).toBeVisible();
  await fold(page,'第一章').click();await expect(editor(page).getByRole('heading',{name:'子章节',exact:true})).toBeHidden();await expect(editor(page).getByText('第一章正文',{exact:true})).toBeHidden();
  await editor(page).getByRole('button',{name:'展开“第一章”的内容',exact:true}).click();await expect(editor(page).getByRole('heading',{name:'子章节',exact:true})).toBeVisible();await expect(editor(page).getByText('子章节正文',{exact:true})).toBeHidden();
  const after=await api(request,'GET',`documents/${f.note.id}`,undefined,f.owner);expect(after.hash).toBe(before.hash);expect(after.revision).toBe(before.revision);
  await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 Markdown（.md）',exact:true}).click();const file=await download;expect(file.suggestedFilename()).toBe(f.note.title+'.md');const markdown=await fs.readFile((await file.path())!,'utf8');expect(markdown).toContain('# 第一章');expect(markdown).toContain('子章节正文');expect(markdown).toContain('更深章节正文');expect(markdown).toContain('第二章较长的内容，第 39 行');expect(markdown).not.toContain('anote_doc:');expect(markdown).not.toContain('heading-fold');expect(markdown).toContain('> 引用正文：结构化版本也应该完整保留');expect(markdown).toContain('下划线与彩色内容');expect(markdown).toContain('**加粗内容**');expect(markdown).toContain('- [x] 已完成的待办');expect(markdown).toContain('```text\nsample code\n```');
  if(!isMobile){await page.getByRole('button',{name:'显示文内目录',exact:true}).click();await page.getByRole('complementary',{name:'文内目录',exact:true}).getByRole('button',{name:'更深章节',exact:true}).click();await expect(editor(page).getByRole('heading',{name:'更深章节',exact:true})).toBeVisible();}
});

test('floating outline and history stay below note controls on scroll and resize',async({page,request,isMobile})=>{
  await open(page,request);
  for(const name of ['文内目录','历史版本']){
    if(isMobile){await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();await page.getByRole('button',{name,exact:true}).click();}
    else await page.getByRole('button',{name:name==='文内目录'?'显示文内目录':name,exact:true}).click();
    const panel=page.getByRole('complementary',{name,exact:true});await expect(panel).toBeVisible();
    for(const scrolling of [false,true]){
      if(scrolling)await page.locator('.document-region:visible').evaluate(el=>el.scrollTop=250);
      await expect.poll(()=>panel.evaluate(el=>{const root=document.querySelector('.document-region:not([aria-hidden="true"])')!,header=root.querySelector('.document-header')!,info=root.querySelector('.document-info')!;return el.getBoundingClientRect().top-Math.max(header.getBoundingClientRect().bottom,info.getBoundingClientRect().bottom);})).toBeGreaterThanOrEqual(0);
      const button=isMobile?page.getByRole('button',{name:'笔记更多操作',exact:true}):page.getByRole('button',{name:'历史版本',exact:true});
      expect(await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
    }
    await page.setViewportSize(isMobile?{width:844,height:390}:{width:1080,height:760});
    await expect.poll(()=>panel.evaluate(el=>{const root=document.querySelector('.document-region:not([aria-hidden="true"])')!,header=root.querySelector('.document-header')!,info=root.querySelector('.document-info')!;return el.getBoundingClientRect().top-Math.max(header.getBoundingClientRect().bottom,info.getBoundingClientRect().bottom);})).toBeGreaterThanOrEqual(0);
    expect(await panel.evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight-6)).toBe(true);
    await panel.getByRole('button',{name:name==='文内目录'?'隐藏文内目录':'收起侧栏',exact:true}).click();
    if(isMobile)await page.setViewportSize({width:393,height:851});
  }
});

test('a folded section expands before Delete, and remote text edits keep the local fold',async({page,request,isMobile,context})=>{
  test.skip(isMobile);const f=await open(page,request);await editor(page).getByText('更深章节正文',{exact:true}).click();await page.keyboard.press('End');await page.keyboard.insertText(' 扩展章节后的新增文字'.repeat(20));const before=await editor(page).evaluate(el=>(el as any).editor.getJSON());
  await fold(page,'第一章').click();expect(await editor(page).evaluate(el=>(el as any).editor.state.selection.$from.parent.type.name)).toBe('heading');await editor(page).evaluate(el=>{const e=(el as any).editor;let position=0;e.state.doc.descendants((n:any,p:number)=>{if(n.type.name==='heading'&&n.textContent==='第一章')position=p+n.nodeSize-1;});e.commands.setTextSelection(position);e.view.focus();});await expect(editor(page)).toBeFocused();await page.keyboard.press('Delete');await expect(editor(page).getByText('第一章正文',{exact:true})).toBeVisible();expect(await editor(page).evaluate(el=>(el as any).editor.getJSON())).toEqual(before);
  await fold(page,'第一章').click();const peer=await context.newPage();try{await peer.goto('/?scope=personal&doc='+f.note.id);const paragraph=editor(peer).getByText('第一章正文',{exact:true});await paragraph.click();await peer.keyboard.press('End');await peer.keyboard.insertText(' 另一窗口修改');await expect.poll(()=>editor(page).evaluate(el=>JSON.stringify((el as any).editor.getJSON()))).toContain('另一窗口修改');await expect(editor(page).getByRole('button',{name:'展开“第一章”的内容',exact:true})).toBeVisible();await expect(editor(page).getByText('第一章正文 另一窗口修改',{exact:true})).toBeHidden();}finally{await peer.close();}
});

test('mobile sticky title and metadata meet without leaking article text through a gap',async({page,request,isMobile},info)=>{
  test.skip(!isMobile);await open(page,request);const region=page.locator('.document-region:visible');
  for(const size of [{width:393,height:851},{width:844,height:390},{width:320,height:640}]){
    await page.setViewportSize(size);await region.evaluate(el=>el.scrollTop=280);
    await expect.poll(()=>region.evaluate(el=>{const title=el.querySelector('.document-header')!.getBoundingClientRect(),metadata=el.querySelector('.document-info')!.getBoundingClientRect();return Math.abs(metadata.top-title.bottom);})).toBeLessThanOrEqual(1);
    expect(await region.evaluate(el=>{const title=el.querySelector('.document-header')!.getBoundingClientRect();const hit=document.elementFromPoint(title.left+title.width/2,title.bottom+.5);return !!hit?.closest('.document-header,.document-info');})).toBe(true);
  }await page.screenshot({path:info.outputPath('mobile-chrome.png')});
});

test('mobile drawer theme menu is clickable, contained and keeps focus inside the dialog',async({page,request,isMobile},info)=>{
  test.skip(!isMobile);await open(page,request);await page.getByRole('button',{name:'展开侧边栏',exact:true}).tap();const drawer=page.getByRole('dialog',{name:'知识库导航',exact:true});await expect(drawer).toBeVisible();
  const trigger=drawer.getByRole('button',{name:'外观模式',exact:true});await trigger.tap();const menu=drawer.getByRole('menu',{name:'外观模式',exact:true});await expect(menu).toBeVisible();const dark=menu.getByRole('menuitemradio').filter({hasText:'Dark'});
  expect(await dark.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);await dark.tap();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(drawer).toBeVisible();await expect(trigger).toBeFocused();await trigger.tap();await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(drawer).toBeVisible();
  await trigger.tap();await menu.getByRole('menuitemradio').filter({hasText:'Light'}).tap();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.screenshot({path:info.outputPath('mobile-theme-menu.png')});
});

import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {schema,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {api,login,slash,switchWorkspace,chooseTheme} from './helpers';
import {person} from './mcp-helpers';

async function fixture(request:APIRequestContext,long=false){
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'顶栏与表格资料'},owner);
  const note=await api(request,'POST','documents',{space_id:book.id,title:'长篇记录与表格'},owner);
  if(long){
    const document=prosemirrorJSONToYDoc(schema,{type:'doc',content:Array.from({length:80},(_,i)=>({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:`第 ${i+1} 段。`+'正文滚动时，平台导航与用户入口位于完整顶栏中。'.repeat(5)}]}))},'default');
    try{await api(request,'POST',`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')},owner);}finally{document.destroy();}
  }
  return {owner,book,note};
}
const context=(page:Page)=>page.getByRole('navigation',{name:'当前位置',exact:true});

test('完整顶栏为正文预留空间，滚动与手机布局不覆盖正文，团队首页保留分享分类',async({page,request})=>{
  const f=await fixture(request,true),team=await api(request,'POST','teams',{name:'顶栏团队'},f.owner);
  await login(page,f.owner);
  for(const width of [1580,1000,390]){
    await page.setViewportSize({width,height:820});await page.goto('/?doc='+f.note.id);
    await expect(page.getByTestId('editor')).toContainText('第 80 段。');await expect(context(page).locator('[aria-current="page"]')).toHaveText(f.note.title);
    const banner=page.getByRole('banner',{name:'工作空间顶栏',exact:true}),bounds=(await banner.boundingBox())!;
    expect(bounds.y).toBe(0);expect(bounds.width).toBe(width);expect(bounds.height).toBe(width===390?60:56);
    expect((await page.locator('.academic-main').boundingBox())!.y).toBe(bounds.y+bounds.height);
    const controls=await page.locator('.workspace-corner-navigation,.workspace-account-tools').evaluateAll(nodes=>nodes.map(el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};}));
    for(const box of controls){expect(box.y).toBeGreaterThanOrEqual(bounds.y);expect(box.y+box.height).toBeLessThanOrEqual(bounds.y+bounds.height);}
    if(width>760){await expect(page.locator('.academic-document-header').getByRole('button',{name:'页宽',exact:true})).toBeVisible();await expect(banner.getByRole('button',{name:'页宽',exact:true})).toHaveCount(0);}
    await page.locator('.document-region').evaluate(el=>el.scrollTop=900);
    await expect.poll(()=>page.locator('.document-region').evaluate(el=>el.scrollTop)).toBeGreaterThan(200);
    expect(await page.locator('.workspace-corner-navigation,.workspace-account-tools').evaluateAll(nodes=>nodes.map(el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};}))).toEqual(controls);
    expect(await banner.evaluate(el=>{const box=el.getBoundingClientRect();return document.elementFromPoint(box.width/2,box.y+box.height/2)?.closest('.workspace-top-banner')===el;})).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:`artifacts/feature-051/web/banner-${width}.png`});
  }
  await page.setViewportSize({width:1580,height:900});await switchWorkspace(page,team.name);
  const tabs=page.locator('.home-tabs');await expect(tabs.getByRole('button')).toHaveText(['团队首页','分享给我','我的分享']);
  for(const label of ['分享给我','我的分享','团队首页']){await tabs.getByRole('button',{name:label,exact:true}).click();await expect(context(page).locator('[aria-current="page"]')).toHaveText(label);}
  await switchWorkspace(page,'个人');await expect(tabs.getByRole('button')).toHaveText(['最近','分享给我','我的分享']);
  await chooseTheme(page,'dark');await expect(page.getByRole('banner',{name:'工作空间顶栏'})).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)');
});

test('单元格和整列底纹可选预设、自定义、清除与撤销，保存后重开保持颜色',async({page,request})=>{
  const f=await fixture(request);await login(page,f.owner);await page.goto('/?doc='+f.note.id);await expect(page.getByTestId('editor')).toBeVisible();await slash(page,'表格','表格');
  const table=page.getByTestId('editor').locator('table'),cell=table.locator('tr').nth(1).locator('td').first(),tools=page.getByRole('toolbar',{name:'表格操作',exact:true});
  await cell.click({button:'right'});await tools.getByRole('button',{name:'单元格底纹',exact:true}).click();
  const palette=page.getByRole('dialog',{name:'单元格底纹设置',exact:true});await palette.getByRole('button',{name:'底纹色 蓝色',exact:true}).click();
  await expect(cell).toHaveCSS('background-color','rgb(219, 234, 254)');await expect(table.locator('tr').nth(1).locator('td').nth(1)).not.toHaveAttribute('style',/background-color/);
  await page.keyboard.press('ControlOrMeta+z');await expect(cell).not.toHaveAttribute('style',/background-color/);
  await table.hover();await page.getByRole('button',{name:'选择第 2 列',exact:true}).click();await tools.getByRole('button',{name:'单元格底纹',exact:true}).click();
  await palette.getByLabel('底纹颜色值',{exact:true}).fill('#cdeaff');await palette.getByRole('button',{name:'应用底纹',exact:true}).click();
  for(let i=0;i<3;i++)await expect(table.locator('tr').nth(i).locator('th,td').nth(1)).toHaveCSS('background-color','rgb(205, 234, 255)');
  await expect(page.getByTestId('document-sync')).toHaveText('已同步');await page.reload();await expect(table.locator('tr').first().locator('th').nth(1)).toHaveCSS('background-color','rgb(205, 234, 255)');
  await table.hover();await page.getByRole('button',{name:'选择第 2 列',exact:true}).click();await tools.getByRole('button',{name:'单元格底纹',exact:true}).click();await palette.getByRole('button',{name:'无底纹颜色',exact:true}).click();
  for(let i=0;i<3;i++)await expect(table.locator('tr').nth(i).locator('th,td').nth(1)).not.toHaveAttribute('style',/background-color/);
  await expect(page.getByTestId('document-sync')).toHaveText('已同步');await page.reload();await expect(table.locator('[style*="background-color"]')).toHaveCount(0);
});

test('斜杠菜单的笔记链接位于最后，搜索和快捷键入口仍可使用',async({page,request})=>{
  const f=await fixture(request);await login(page,f.owner);await page.goto('/?doc='+f.note.id);const editor=page.getByTestId('editor');await expect(editor).toBeVisible();await editor.click();await page.keyboard.insertText('/');
  const menu=page.getByRole('listbox',{name:'插入内容',exact:true});await expect(menu.getByRole('option').last()).toContainText('笔记链接');await expect(menu.getByRole('option').first()).toContainText('标题 1');
  await page.keyboard.insertText('笔记链接');await expect(menu.getByRole('option')).toHaveCount(1);await menu.getByRole('option').click();await expect(page.getByRole('dialog',{name:'插入笔记链接',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await editor.click();await page.keyboard.press('ControlOrMeta+k');await expect(page.getByRole('dialog',{name:'插入笔记链接',exact:true})).toBeVisible();
});

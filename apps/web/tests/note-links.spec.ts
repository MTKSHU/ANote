import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {api,admin,login,slash,selectText} from './helpers';

async function person(request:APIRequestContext,root:any){
  const username='reference-'+randomUUID().slice(0,8),password='Note-reference-050-123!';
  await api(request,'POST','users',{username,password,name:username},root);
  return {...await api(request,'POST','auth/login',{username,password}),username,password};
}
async function fixture(request:APIRequestContext){
  const root=await admin(request),owner=await person(request,root),book=await api(request,'POST','spaces',{kind:'personal',name:'链接研究资料'},owner);
  const source=await api(request,'POST','documents',{space_id:book.id,title:'研究过程与引用'},owner),target=await api(request,'POST','documents',{space_id:book.id,title:'实验方法参考'},owner);
  return {root,owner,book,source,target};
}
async function choose(page:Page,title:string){
  const picker=page.getByRole('dialog',{name:'插入笔记链接',exact:true});await expect(picker).toBeVisible();
  await picker.getByRole('combobox',{name:'搜索可读笔记',exact:true}).fill(title);
  await picker.getByRole('option',{name:new RegExp(title)}).click();await expect(picker).toBeHidden();
}
const references=(page:Page)=>page.getByRole('region',{name:'参考笔记',exact:true});

test('选中文字与斜杠均可插入笔记链接，底部参考去重跟随标题，阅读跳转与新标签保留原稿',async({page,context,request})=>{
  const f=await fixture(request);await login(page,f.owner);await page.goto('/?doc='+f.source.id);
  const editor=page.getByTestId('editor');await expect(editor).toHaveAttribute('contenteditable','true');
  await editor.fill('请参考实验过程。');await selectText(page);await expect(page.getByRole('group',{name:'编辑工具',exact:true})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');await choose(page,f.target.title);
  await expect(editor.locator('a')).toHaveText('请参考实验过程。');await expect(editor.locator('a')).toHaveAttribute('href','/?doc='+f.target.id);
  await expect(references(page).getByRole('link')).toHaveCount(1);await expect(references(page)).toContainText(f.target.title);
  await editor.locator(':scope > p').last().click();await page.keyboard.press('End');await page.keyboard.press('Enter');await slash(page,'笔记链接');await choose(page,f.target.title);
  await expect(editor.locator('a')).toHaveCount(2);await expect(references(page).getByRole('link')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');await page.reload();
  await expect(editor.locator('a')).toHaveCount(2);await expect(references(page).getByRole('link')).toHaveCount(1);
  await api(request,'PATCH',`documents/${f.target.id}`,{title:'已更新的实验方法参考'},f.owner);
  await page.evaluate(()=>window.dispatchEvent(new Event('anote-note-changed')));await expect(references(page)).toContainText('已更新的实验方法参考');
  const opened=context.waitForEvent('page');await references(page).getByRole('link').click({modifiers:['ControlOrMeta']});const tab=await opened;
  await expect(tab.getByLabel('笔记标题',{exact:true})).toHaveValue('已更新的实验方法参考');await tab.close();
  expect(new URL(page.url()).searchParams.get('doc')).toBe(f.source.id);await expect(editor).toContainText('请参考实验过程。');
  const documentRequests:string[]=[];page.on('request',request=>{if(request.isNavigationRequest()&&request.resourceType()==='document'&&request.frame()===page.mainFrame())documentRequests.push(request.url());});
  await page.getByRole('button',{name:'阅读',exact:true}).click();await editor.locator('a').first().click();
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('已更新的实验方法参考');
  expect(documentRequests).toEqual([]);
  await page.goto('/?doc='+f.source.id);await expect(editor).toContainText('请参考实验过程。');await expect(references(page).getByRole('link')).toHaveCount(1);
  await page.screenshot({path:'artifacts/preview-050/web/note-references.png',animations:'disabled'});
});

test('笔记选择与参考列表只展示当前可读目标，权限撤销后不再泄露标题且链接不能越权打开',async({page,request})=>{
  const f=await fixture(request),peer=await person(request,f.root),book=await api(request,'POST','spaces',{kind:'personal',name:'他人的私人资料'},peer),target=await api(request,'POST','documents',{space_id:book.id,title:'不可泄露的目标标题'},peer);
  await login(page,f.owner);await page.goto('/?doc='+f.source.id);const editor=page.getByTestId('editor');await expect(editor).toHaveAttribute('contenteditable','true');
  await editor.evaluate((el,id)=>(el as any).editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'待授权参考',marks:[{type:'link',attrs:{href:'/?doc='+id,target:null}}]}]},{type:'paragraph'}]}),target.id);
  await expect(references(page)).toHaveCount(0);await editor.locator(':scope > p').last().click();await page.keyboard.press('ControlOrMeta+k');
  const picker=page.getByRole('dialog',{name:'插入笔记链接',exact:true});await picker.getByRole('combobox',{name:'搜索可读笔记',exact:true}).fill(target.title);
  await expect(picker.getByRole('option')).toHaveCount(0);await expect(picker).not.toContainText(target.title);await page.keyboard.press('Escape');
  let sharing=await api(request,'GET',`documents/${target.id}/sharing`,undefined,peer);
  await api(request,'PATCH',`documents/${target.id}/sharing`,{visibility:'private',access_revision:sharing.access_revision,collaborators:[{user_id:f.owner.user.id,role:'viewer'}]},peer);
  await page.evaluate(()=>window.dispatchEvent(new Event('anote-note-changed')));await expect(references(page)).toContainText(target.title);
  sharing=await api(request,'GET',`documents/${target.id}/sharing`,undefined,peer);
  await api(request,'PATCH',`documents/${target.id}/sharing`,{visibility:'private',access_revision:sharing.access_revision,collaborators:[]},peer);
  await page.evaluate(()=>window.dispatchEvent(new Event('anote-note-changed')));await expect(references(page)).toHaveCount(0);
  const sourceURL=page.url(),documentRequests:string[]=[];page.on('request',request=>{if(request.isNavigationRequest()&&request.resourceType()==='document'&&request.frame()===page.mainFrame())documentRequests.push(request.url());});
  await page.getByRole('button',{name:'阅读',exact:true}).click();await editor.locator('a').click();
  await expect(page.getByRole('alert')).toContainText('无此笔记权限');
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(f.source.title);await expect(page.locator('body')).not.toContainText(target.title);
  expect(page.url()).toBe(sourceURL);expect(documentRequests).toEqual([]);
  await api(request,'GET',`documents/${target.id}`,undefined,f.owner,403);
});

import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {api,admin,login,openWorkspaceSwitcher,openWorkspaceSettings,slash} from './helpers';

test.skip(({isMobile})=>!isMobile,'移动交互在专用触摸设备项目中验证');

async function person(request:APIRequestContext,root:any,name='移动端研究者'){
  const username='mobile-'+randomUUID().slice(0,8),password='Mobile-preview-050-123!';
  await api(request,'POST','users',{username,password,name},root);
  return {...await api(request,'POST','auth/login',{username,password}),username,password};
}
async function fixture(request:APIRequestContext,teamScope=false){
  const root=await admin(request),owner=await person(request,root);
  const team=teamScope?await api(request,'POST','teams',{name:'手机团队研究'},owner):null;
  const library=await api(request,'POST','spaces',{kind:team?'team':'personal',name:'随身研究资料',...(team?{team_id:team.id}:{})},owner);
  const notes=[];for(const title of ['手机阅读笔记','随时切换的另一篇'])notes.push(await api(request,'POST','documents',{space_id:library.id,title},owner));
  return {root,owner,library,notes};
}
const sidebar=(page:Page)=>page.locator('.academic-sidebar');
const list=(page:Page)=>page.getByRole('dialog',{name:'同库笔记',exact:true});
const expand=(page:Page)=>page.getByRole('button',{name:'展开侧边栏',exact:true});
async function noHorizontalOverflow(page:Page){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  const editor=await page.getByTestId('editor').boundingBox();
  if(editor)expect(editor.width).toBeGreaterThanOrEqual(page.viewportSize()!.width-70);
}
async function screenshot(page:Page,name:string){
  await page.screenshot({path:`artifacts/preview-050/web/${test.info().project.name}-${name}.png`,animations:'disabled'});
}
async function edit(page:Page){
  const button=page.getByRole('button',{name:'编辑',exact:true});
  await expect(button).toBeVisible();await button.tap();
  await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','true');
}

test('手机导航和同库笔记按需弹出，触摸选择与遮罩关闭，横屏仍可完整阅读',async({page,request})=>{
  const f=await fixture(request,true);await login(page,f.owner);
  let releaseContext!:()=>void;const contextReady=new Promise<void>(resolve=>{releaseContext=resolve;});
  await page.route('**/api/spaces',async route=>{await contextReady;await route.continue();});
  try{
  await page.goto('/?doc='+f.notes[0].id);
  await expect(page.getByTestId('editor')).toBeVisible();await expect(expand(page)).toBeVisible();
  await expect(sidebar(page)).toBeHidden();await expect(list(page)).toBeHidden();await noHorizontalOverflow(page);
  await screenshot(page,'note-portrait');
  await expand(page).tap();await expect(sidebar(page)).toBeVisible();await expect(page.getByRole('dialog',{name:'知识库导航',exact:true})).toHaveAttribute('aria-modal','true');
  }finally{releaseContext();}
  // The note can load before workspace context; late library/page/team metadata
  // must update an already opened drawer without dismissing it.
  await expect(sidebar(page).locator('.sidebar-library-note')).toHaveCount(2);
  await page.unroute('**/api/spaces');
  await page.evaluate(()=>getSelection()?.removeAllRanges());
  await screenshot(page,'navigation');
  await sidebar(page).locator('.sidebar-library-note').filter({hasText:f.notes[1].title}).tap();
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(f.notes[1].title);await expect(sidebar(page)).toBeHidden();
  await expand(page).tap();await expect(sidebar(page)).toBeVisible();
  await page.touchscreen.tap(page.viewportSize()!.width-4,Math.floor(page.viewportSize()!.height*.7));
  await expect(sidebar(page)).toBeHidden();await expect(expand(page)).toBeFocused();
  await expand(page).tap();expect(await page.evaluate(()=>!window.dispatchEvent(new Event('anote:mobile-back',{cancelable:true})))).toBe(true);await expect(sidebar(page)).toBeHidden();
  await page.getByRole('button',{name:'显示笔记列表',exact:true}).tap();await expect(list(page)).toBeVisible();await expect(list(page)).toHaveAttribute('aria-modal','true');
  await screenshot(page,'note-list');
  await list(page).getByRole('button',{name:f.notes[0].title,exact:true}).tap();
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(f.notes[0].title);await expect(list(page)).toBeHidden();
  await page.getByRole('button',{name:'显示笔记列表',exact:true}).tap();await page.keyboard.press('Escape');await expect(list(page)).toBeHidden();
  await page.getByRole('button',{name:'显示笔记列表',exact:true}).tap();expect(await page.evaluate(()=>!window.dispatchEvent(new Event('anote:mobile-back',{cancelable:true})))).toBe(true);await expect(list(page)).toBeHidden();
  await page.setViewportSize({width:844,height:390});await expect(sidebar(page)).toBeHidden();await expect(list(page)).toBeHidden();await noHorizontalOverflow(page);
  await expand(page).tap();await expect(sidebar(page)).toBeVisible();await page.keyboard.press('Escape');await expect(sidebar(page)).toBeHidden();
  await screenshot(page,'note-landscape');
});

test('手机编辑在键盘可用高度缩小时继续输入，阅读切换与刷新保留标题和正文',async({page,request})=>{
  const f=await fixture(request);await login(page,f.owner);await page.goto('/?doc='+f.notes[0].id);await edit(page);
  const editor=page.getByTestId('editor'),text='离开电脑后也能记录实验结果，内容应在重新打开时完整保留。';
  await editor.tap();await page.keyboard.insertText(text);await expect(page.getByTestId('document-sync')).toHaveText('已同步');
  await editor.evaluate(el=>el.dataset.mobileInstance='retained');
  const portrait=page.viewportSize()!;await page.setViewportSize({width:portrait.width,height:360});
  await editor.tap();await page.keyboard.press('End');await page.keyboard.insertText('软键盘可用区域缩小时继续编辑。');
  await expect(editor).toHaveAttribute('data-mobile-instance','retained');await expect(page.getByTestId('document-sync')).toHaveText('已同步');
  await noHorizontalOverflow(page);await page.setViewportSize(portrait);
  await page.getByLabel('笔记标题',{exact:true}).fill('手机保存后的研究记录');await editor.tap();
  await expect(page.getByTestId('document-sync')).toHaveText('已同步');
  await slash(page,'笔记链接');const picker=page.getByRole('dialog',{name:'插入笔记链接',exact:true});
  await picker.getByRole('combobox',{name:'搜索可读笔记',exact:true}).fill(f.notes[1].title);await picker.getByRole('option',{name:new RegExp(f.notes[1].title)}).tap();
  await expect(page.getByRole('region',{name:'参考笔记',exact:true})).toContainText(f.notes[1].title);await expect(page.getByTestId('document-sync')).toHaveText('已同步');
  await page.getByRole('button',{name:'阅读',exact:true}).tap();await expect(editor).toHaveAttribute('contenteditable','false');
  await expect(list(page)).toBeHidden();await noHorizontalOverflow(page);await screenshot(page,'reading');
  await editor.getByRole('link',{name:f.notes[1].title,exact:true}).tap();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(f.notes[1].title);
  await page.goto('/?doc='+f.notes[0].id);
  await page.reload();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('手机保存后的研究记录');
  await expect(page.getByTestId('editor')).toContainText(text);await expect(page.getByTestId('editor')).toContainText('软键盘可用区域缩小时继续编辑。');
  expect((await api(request,'GET',`documents/${f.notes[0].id}`,undefined,f.owner)).title).toBe('手机保存后的研究记录');
});

test('手机工作空间菜单和设置可操作，只读知识库可阅读而不能修改',async({page,request})=>{
  const f=await fixture(request),reader=await person(request,f.root,'手机只读成员'),team=await api(request,'POST','teams',{name:'随身团队工作空间'},f.owner);
  await api(request,'POST',`spaces/${f.library.id}/sharing/members`,{identity:reader.username},f.owner);
  await login(page,f.owner);
  const choices=await openWorkspaceSwitcher(page);await choices.getByRole('menuitemradio',{name:team.name,exact:true}).tap();
  await expect(page.locator('.academic-page-header h1')).toHaveText(team.name);await expect(sidebar(page)).toBeHidden();
  const settings=await openWorkspaceSettings(page);await expect(settings).toBeVisible();
  const box=(await settings.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width+1);
  await screenshot(page,'settings');await settings.locator(':scope > header').getByRole('button',{name:'关闭',exact:true}).tap();
  await page.request.post('/api/auth/logout');await login(page,reader);await page.goto('/?doc='+f.notes[0].id);
  await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','false');
  await expect(page.getByRole('button',{name:'阅读',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'显示笔记列表',exact:true}).tap();await expect(list(page)).toBeVisible();
  await expect(list(page).getByRole('button',{name:'新建笔记',exact:true})).toHaveCount(0);await expect(list(page).locator('.note-list-settings')).toHaveCount(0);
  await list(page).getByRole('button',{name:f.notes[1].title,exact:true}).tap();await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','false');
  await api(request,'PATCH',`documents/${f.notes[1].id}`,{title:'无权修改'},reader,403);
  await noHorizontalOverflow(page);await screenshot(page,'readonly');
});

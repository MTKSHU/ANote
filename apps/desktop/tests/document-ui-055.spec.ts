import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {api} from '../../web/tests/helpers';
import {person} from '../../web/tests/mcp-helpers';

const origin='http://127.0.0.1:3200';
const list=(page:Page)=>page.getByRole('complementary',{name:'同库笔记',exact:true});
const item=(page:Page,title:string)=>list(page).getByRole('button',{name:title,exact:true});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test.beforeAll(async({request})=>{
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');
  expect(process.env.BASE_URL).toBe('http://anote.internal:3000');
  expect(process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN).toBe(origin);
  expect((await api(request,'GET','platform/public')).public_origin).toBe(origin);
});

async function readingMode(page:Page){
  const toggle=page.locator('.document-actions .document-mode-toggle');
  await expect(toggle).toBeEnabled();
  if(await toggle.getAttribute('data-mode')==='edit')await toggle.click();
  await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','false');
}

async function watchTree(page:Page,folderName:string,noteTitle:string){
  await page.evaluate(({folderName,noteTitle})=>{
    const root=document.querySelector('.library-note-list')!;
    const nav=root.querySelector('nav')!;
    const folder=[...root.querySelectorAll('.note-list-folder')].find(node=>node.textContent===folderName)!;
    const note=[...root.querySelectorAll('.note-list-item')].find(node=>node.textContent===noteTitle)!;
    const probe={root,nav,folder,note,removed:false,scrollTop:nav.scrollTop,width:root.getBoundingClientRect().width};
    const observer=new MutationObserver(records=>{
      for(const record of records)for(const removed of record.removedNodes)
        if(removed===folder||removed===note||removed.contains(folder)||removed.contains(note))probe.removed=true;
    });
    // Observe the document too, so replacing the entire list is caught even if
    // the detached old tree retains its children and scroll position.
    observer.observe(document,{childList:true,subtree:true});
    (window as any).__nativeNavigation055={probe,observer};
  },{folderName,noteTitle});
}

async function treeState(page:Page){
  return page.evaluate(()=>{
    const {probe}=(window as any).__nativeNavigation055;
    return {
      sameRoot:document.querySelector('.library-note-list')===probe.root,
      sameNav:document.querySelector('.library-note-list nav')===probe.nav,
      folderRetained:probe.folder.isConnected,noteRetained:probe.note.isConnected,
      removed:probe.removed,scrollTop:probe.nav.scrollTop,initialScrollTop:probe.scrollTop,
      width:probe.root.getBoundingClientRect().width,initialWidth:probe.width,
    };
  });
}

test('packaged Electron reading switches keep the same library list DOM, scroll and folder state',async({request},testInfo)=>{
  const executable=process.env.DESKTOP_EXECUTABLE;
  expect(executable,'A real packaged Linux Electron executable is required').toBeTruthy();
  const executablePath=path.resolve(executable!);
  const asar=path.join(path.dirname(executablePath),'resources/app.asar');
  const asarSha256=hash(await fs.readFile(asar));
  const owner=await person(request);
  const book=await api(request,'POST','spaces',{kind:'personal',name:'055 原生客户端阅读导航'},owner);
  const folder=await api(request,'POST',`spaces/${book.id}/folders`,{name:'原生展开目录'},owner);
  const closed=await api(request,'POST',`spaces/${book.id}/folders`,{name:'原生保留折叠目录'},owner);
  const notes:{id:string;title:string}[]=[];
  for(let index=0;index<24;index++)notes.push(await api(request,'POST','documents',{
    space_id:book.id,folder_id:folder.id,title:'原生阅读条目 '+String(index).padStart(2,'0'),
  },owner));
  await api(request,'POST','documents',{space_id:book.id,folder_id:closed.id,title:'原生折叠目录中的笔记'},owner);
  const output=path.resolve(process.env.ANOTE_RELEASE_TEST_OUTPUT||'artifacts/note-ui-055/desktop');
  const profile=path.join(output,'navigation-profile-'+randomUUID());
  await fs.mkdir(profile,{recursive:true});
  let app:ElectronApplication|undefined;
  try{
    app=await _electron.launch({
      executablePath,args:['--no-sandbox','--password-store=basic','--document='+notes[10].id],
      env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:'1'},
    });
    const runtime=await app.evaluate(({app})=>({
      packaged:app.isPackaged,version:app.getVersion(),platform:process.platform,appPath:app.getAppPath(),
    }));
    expect(runtime).toMatchObject({packaged:true,version:'0.5.5',platform:'linux'});
    expect(runtime.appPath).toBe(asar);
    const page=await app.firstWindow();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1450,700));
    await expect.poll(()=>page.evaluate(()=>({width:innerWidth,height:innerHeight}))).toEqual({width:1450,height:700});
    await page.getByRole('button',{name:'连接服务器',exact:true}).click();
    await page.getByLabel('服务地址',{exact:true}).fill(process.env.BASE_URL!);
    await page.getByLabel('用户名',{exact:true}).fill(owner.username);
    await page.getByLabel('密码',{exact:true}).fill(owner.password);
    await page.getByRole('button',{name:'登录并连接',exact:true}).click();
    await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(notes[10].title);
    await expect(item(page,folder.name)).toBeVisible();
    await expect(list(page).locator('.note-list-item')).toHaveCount(25);
    await item(page,closed.name).click();
    await expect(item(page,closed.name)).toHaveAttribute('aria-expanded','false');
    await list(page).getByRole('separator',{name:'调整笔记列表宽度',exact:true}).press('ArrowRight');
    await readingMode(page);
    await item(page,notes[11].title).evaluate(element=>element.scrollIntoView({block:'center'}));
    await watchTree(page,folder.name,notes[10].title);
    expect((await treeState(page)).initialScrollTop,'The fixture must exercise a scrolled list').toBeGreaterThan(0);

    const workspaceRequests:string[]=[],authorized:string[]=[],states:Awaited<ReturnType<typeof treeState>>[]=[];
    page.on('request',request=>{
      const url=new URL(request.url());
      if(/^\/api\/(spaces|documents|teams|trash(?:\/.*)?|platform\/public)$/.test(url.pathname)||/^\/api\/spaces\/[^/]+\/(folders|catalog)$/.test(url.pathname))workspaceRequests.push(url.pathname+url.search);
    });
    for(const note of [notes[11],notes[10]]){
      const preview=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/documents/${note.id}/preview`&&response.status()===200);
      await item(page,note.title).click();
      authorized.push((await preview).url());
      await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(note.title);
      await readingMode(page);
      const state=await treeState(page);states.push(state);
      expect(state.sameRoot).toBe(true);expect(state.sameNav).toBe(true);
      expect(state.folderRetained).toBe(true);expect(state.noteRetained).toBe(true);
      expect(state.removed).toBe(false);
      expect(state.scrollTop).toBeCloseTo(state.initialScrollTop,0);
      expect(state.width).toBe(state.initialWidth);
      await expect(item(page,closed.name)).toHaveAttribute('aria-expanded','false');
    }
    expect(workspaceRequests).toEqual([]);
    expect(authorized).toHaveLength(2);
    expect(hash(await fs.readFile(asar))).toBe(asarSha256);
    await page.screenshot({path:path.join(output,'native-navigation.png'),animations:'disabled'});
    const evidence={runtime,asarSha256,profile,states,workspaceRequests,authorized:authorized.map(value=>new URL(value).pathname),scope:'Real Linux packaged Electron in Docker/Xvfb; synthetic isolated QA account; no renderer or API mocks'};
    await fs.writeFile(path.join(output,'native-navigation.json'),JSON.stringify(evidence,null,2)+'\n');
    await testInfo.attach('native-navigation.json',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
  }finally{await app?.close().catch(()=>{});}
});

import {test,expect,type Page,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {api,login} from './helpers';
import {person} from './mcp-helpers';

test.beforeAll(async({request})=>{
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');
  expect(['http://127.0.0.1:3200','http://127.0.0.1:3210']).toContain(process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3200');
  expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe((process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3200'));
});
const list=(page:Page)=>page.getByRole('complementary',{name:'同库笔记',exact:true});
const item=(page:Page,title:string)=>list(page).getByRole('button',{name:title,exact:true});
async function readMode(page:Page){
  const toggle=page.locator('.document-actions .document-mode-toggle');await expect(toggle).toBeEnabled();
  if(await toggle.getAttribute('data-mode')==='edit')await toggle.click();
  await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','false');
}
async function body(request:APIRequestContext,account:any,note:any,text:string){
  const document=prosemirrorJSONToYDoc(schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]}]},'default');
  try{await api(request,'POST',`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,migrationEncoding:2,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')},account);}finally{document.destroy();}
}
async function watchTree(page:Page,folderName:string,noteTitle:string){
  await page.evaluate(({folderName,noteTitle})=>{
    const root=document.querySelector('.library-note-list')!,nav=root.querySelector('nav')!,folder=[...root.querySelectorAll('.note-list-folder')].find(node=>node.textContent===folderName)!,note=[...root.querySelectorAll('.note-list-item')].find(node=>node.textContent===noteTitle)!;
    const probe={root,nav,folder,note,removed:false,scrollTop:nav.scrollTop,width:root.getBoundingClientRect().width};
    const observer=new MutationObserver(records=>{for(const record of records)for(const removed of record.removedNodes)if(removed===folder||removed===note||removed.contains(folder)||removed.contains(note))probe.removed=true;});observer.observe(root,{childList:true,subtree:true});
    (window as any).__noteNavigation055={...probe,probe,observer};
  },{folderName,noteTitle});
}
async function treeState(page:Page){return page.evaluate(()=>{const {probe}=((window as any).__noteNavigation055);return {sameRoot:document.querySelector('.library-note-list')===probe.root,folderRetained:probe.folder.isConnected,noteRetained:probe.note.isConnected,removed:probe.removed,scrollTop:probe.nav.scrollTop,initialScrollTop:probe.scrollTop,width:probe.root.getBoundingClientRect().width,initialWidth:probe.width};});}

test('reading-mode switches preserve the same library tree, scroll, width and folder state without a workspace reload',async({page,request})=>{
  await page.setViewportSize({width:1450,height:700});
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'055 稳定阅读列表'},owner),folder=await api(request,'POST',`spaces/${book.id}/folders`,{name:'展开目录'},owner),closed=await api(request,'POST',`spaces/${book.id}/folders`,{name:'保留折叠目录'},owner),notes:any[]=[];
  for(let index=0;index<24;index++)notes.push(await api(request,'POST','documents',{space_id:book.id,folder_id:folder.id,title:'阅读条目 '+String(index).padStart(2,'0')},owner));
  await api(request,'POST','documents',{space_id:book.id,folder_id:closed.id,title:'折叠目录中的笔记'},owner);
  await login(page,owner);await page.goto('/?scope=personal&doc='+notes[10].id);
  await expect(item(page,'展开目录')).toBeVisible();await expect(list(page).locator('.note-list-item')).toHaveCount(25);await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(notes[10].title);
  await item(page,'保留折叠目录').click();await expect(item(page,'保留折叠目录')).toHaveAttribute('aria-expanded','false');
  await list(page).getByRole('separator',{name:'调整笔记列表宽度',exact:true}).press('ArrowRight');
  await readMode(page);await item(page,notes[11].title).evaluate(element=>element.scrollIntoView({block:'center'}));
  await watchTree(page,'展开目录',notes[10].title);
  const requests:string[]=[],metadata:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(/^\/api\/(spaces|documents|teams|trash(?:\/.*)?|platform\/public)$/.test(url.pathname)||/^\/api\/spaces\/[^/]+\/(folders|catalog)$/.test(url.pathname))requests.push(url.pathname+url.search);if(url.pathname.startsWith('/api/documents/')&&(url.pathname.endsWith('/preview')||url.searchParams.get('content')==='metadata'))metadata.push(url.pathname+url.search);});
  for(const note of [notes[11],notes[10]]){
    const authorized=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/documents/${note.id}/preview`&&response.status()===200);
    await item(page,note.title).click();await authorized;await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(note.title);
    const current=await treeState(page);expect(current.sameRoot).toBe(true);expect(current.folderRetained).toBe(true);expect(current.noteRetained).toBe(true);expect(current.removed).toBe(false);expect(current.scrollTop).toBeCloseTo(current.initialScrollTop,0);expect(current.width).toBe(current.initialWidth);
    await expect(item(page,'保留折叠目录')).toHaveAttribute('aria-expanded','false');await readMode(page);
  }
  expect(requests).toEqual([]);expect(metadata.length).toBeGreaterThanOrEqual(2);
});

test('same-library refresh keeps existing rows mounted while explicit folder and note changes still update the catalog',async({page,request})=>{
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'055 目录后台刷新'},owner),folder=await api(request,'POST',`spaces/${book.id}/folders`,{name:'保持挂载的目录'},owner),note=await api(request,'POST','documents',{space_id:book.id,folder_id:folder.id,title:'保持挂载的笔记'},owner);
  await login(page,owner);await page.goto('/?doc='+note.id);await expect(item(page,folder.name)).toBeVisible();await expect(page.getByTestId('editor')).toBeVisible();await readMode(page);await watchTree(page,folder.name,note.title);
  await api(request,'PATCH',`spaces/${book.id}/folders/${folder.id}`,{name:'目录已更新',parent_id:null},owner);const added=await api(request,'POST','documents',{space_id:book.id,folder_id:folder.id,title:'后台新增的笔记'},owner);
  let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});
  await page.route(new RegExp(`/api/spaces/${book.id}/(folders|catalog)$`),async route=>{await blocked;await route.continue();});
  const pending=page.waitForRequest(request=>new URL(request.url()).pathname===`/api/spaces/${book.id}/folders`);
  try{await page.evaluate(()=>window.dispatchEvent(new Event('anote-note-changed')));await pending;const during=await treeState(page);expect(during.folderRetained).toBe(true);expect(during.noteRetained).toBe(true);expect(during.removed).toBe(false);}finally{unblock();}
  await expect(item(page,'目录已更新')).toBeVisible();await expect(item(page,added.title)).toBeVisible();const after=await treeState(page);expect(after.sameRoot).toBe(true);expect(after.folderRetained).toBe(true);expect(after.noteRetained).toBe(true);expect(after.removed).toBe(false);
});

test('same-library fast switching reauthorizes a cached note after reading permission is revoked',async({page,request})=>{
  const owner=await person(request),reader=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'055 权限复核'},owner),one=await api(request,'POST','documents',{space_id:book.id,title:'仍在列表中的笔记甲'},owner),two=await api(request,'POST','documents',{space_id:book.id,title:'已缓存的笔记乙'},owner),secret='撤权后不可显示 '+randomUUID();
  await body(request,owner,two,secret);await api(request,'POST',`spaces/${book.id}/sharing/members`,{identity:reader.username},owner);
  await login(page,reader);await page.goto('/?doc='+two.id);await expect(page.getByTestId('editor')).toContainText(secret);await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','false');await item(page,one.title).click();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(one.title);
  await api(request,'DELETE',`spaces/${book.id}/sharing/members/${reader.user.id}`,undefined,owner);await expect(item(page,two.title)).toBeVisible();
  await page.evaluate(secret=>{(window as any).__revoked055=false;new MutationObserver(()=>{if([...document.querySelectorAll('[data-testid="editor"],[data-testid="document-preview-body"]')].some(element=>element.textContent?.includes(secret)))(window as any).__revoked055=true;}).observe(document,{childList:true,subtree:true,characterData:true});},secret);
  const denied=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/documents/${two.id}/preview`&&response.status()===403);await item(page,two.title).click();await denied;await expect(page.getByTestId('editor')).toHaveCount(0);await expect(page.getByTestId('document-preview-body')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__revoked055)).toBe(false);
});

test('a delayed catalog from the previous library cannot replace the next library context',async({page,request})=>{
  const owner=await person(request),books:any[]=[];for(const name of ['目录请求延迟的知识库','当前知识库']){const book=await api(request,'POST','spaces',{kind:'personal',name},owner),folder=await api(request,'POST',`spaces/${book.id}/folders`,{name:name+'目录'},owner),note=await api(request,'POST','documents',{space_id:book.id,folder_id:folder.id,title:name+'笔记'},owner);books.push({book,folder,note});}
  await login(page,owner);let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});await page.route(new RegExp(`/api/spaces/${books[0].book.id}/(folders|catalog)$`),async route=>{await blocked;await route.continue();});
  const pending=page.waitForRequest(request=>new URL(request.url()).pathname===`/api/spaces/${books[0].book.id}/folders`);await page.goto('/?doc='+books[0].note.id);await pending;await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(books[0].note.title);
  let stale:Promise<any>|undefined;try{await page.locator('.sidebar-library-note').filter({hasText:books[1].note.title}).click();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(books[1].note.title);await expect(item(page,books[1].folder.name)).toBeVisible();stale=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/spaces/${books[0].book.id}/catalog`);}finally{unblock();}
  await stale;
  await expect(list(page).locator('.note-list-library')).toHaveText(books[1].book.name);await expect(item(page,books[1].folder.name)).toBeVisible();await expect(item(page,books[0].folder.name)).toHaveCount(0);await expect(list(page).locator('.note-list-item')).toHaveText([books[1].note.title]);
});

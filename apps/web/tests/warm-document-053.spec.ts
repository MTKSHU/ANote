import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,login,signOutWorkspace} from './helpers';
import {person} from './mcp-helpers';
import {warmDocumentFixture,initWarmDocumentProbe,warmSwitches,verifyWarmBody,documentGuid} from '../../../validation/fixtures/warm-document-053';
const label=process.env.ANOTE_WARM_LABEL||'candidate',root=path.resolve('artifacts/preview-053/web',label),expectCache=process.env.ANOTE_EXPECT_SESSION_CACHE!=='0';
test('17MiB历史TODO来回切换复用文档，立即切走的编辑和全部历史保持',async({page,request})=>{
  const fixture=await warmDocumentFixture(request);await login(page,fixture.owner);await initWarmDocumentProbe(page,fixture.id);
  await page.goto('/?scope=personal&doc='+fixture.id);
  await expect(page.getByTestId('editor').locator('input[type="checkbox"]')).toHaveCount(102);
  const metadataReads:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname===`/api/documents/${fixture.id}`&&url.searchParams.get('content')==='metadata')metadataReads.push(request.url());});
  const performance=await warmSwitches(page,fixture,expectCache);expect(metadataReads.length).toBeGreaterThanOrEqual(3);
  const editor=page.getByTestId('editor'),paragraph=editor.locator(`p[data-block-id="${fixture.targetBlockId}"]`),tail=' 保留切换前输入 '+randomUUID().slice(0,8);
  await paragraph.click();await page.keyboard.press('End');await page.keyboard.insertText(tail);const expected=await paragraph.textContent();
  await page.locator('.library-note-list .note-list-item').filter({hasText:fixture.control.title}).click();await expect(editor.locator('input[type="checkbox"]')).toHaveCount(0);
  await page.locator('.library-note-list .note-list-item').filter({hasText:fixture.title}).click();await expect(paragraph).toHaveText(expected!);
  const snapshot=await editor.evaluate(element=>(element as any).editor.getJSON());await expect.poll(async()=>JSON.stringify((await api(request,'GET',`documents/${fixture.id}`,undefined,fixture.owner)).snapshot),{timeout:60000}).toBe(JSON.stringify(snapshot));await verifyWarmBody(request,fixture,snapshot);
  await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'warm-document-evidence.json'),JSON.stringify({recordedAt:new Date().toISOString(),label,fixture:fixture.stats,performance,metadataRechecked:metadataReads.length,bodyAndHistoryPreserved:true},null,2)+'\n');
});
test('另一个标签页写入的IndexedDB更新在返回时合并，即使协作连接尚未恢复',async({page,context,request})=>{
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'多标签页缓存'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'标签页缓存 '+randomUUID().slice(0,8)},owner);
  await login(page,owner);await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('editor')).toBeVisible();const guid=await documentGuid(page);
  await page.getByRole('link',{name:'首页',exact:true}).click();const returnButton=page.locator('.note-open').filter({hasText:note.title});await expect(returnButton).toBeVisible();
  const peer=await context.newPage();try{
    await peer.goto('/?scope=personal&doc='+note.id);const editor=peer.getByTestId('editor');await expect(editor).toBeVisible();await editor.locator(':scope > p').last().click();const text='另一个标签页的更新 '+randomUUID();await peer.keyboard.insertText(text);await peer.keyboard.press('ControlOrMeta+s');await expect(peer.getByTestId('document-sync')).toHaveText('已保存');await peer.getByRole('link',{name:'首页',exact:true}).click();await expect(peer.getByTestId('editor')).toHaveCount(0);
    await page.routeWebSocket('**/collab',socket=>socket.close());await returnButton.click();await expect(page.getByTestId('editor')).toContainText(text);if(expectCache)expect(await documentGuid(page)).toBe(guid);
    await page.getByRole('link',{name:'首页',exact:true}).click();await peer.locator('.note-open').filter({hasText:note.title}).click();await expect(editor).toContainText(text);
    await editor.locator(':scope > p').last().click();await peer.keyboard.press('Home');await peer.keyboard.press('Delete');await peer.keyboard.press('Delete');await peer.keyboard.press('Delete');await peer.keyboard.press('ControlOrMeta+s');await expect(peer.getByTestId('document-sync')).toHaveText('已保存');await peer.getByRole('link',{name:'首页',exact:true}).click();
    await returnButton.click();await expect(page.getByTestId('editor')).toContainText(text.slice(3));await expect(page.getByTestId('editor')).not.toContainText(text);if(expectCache)expect(await documentGuid(page)).toBe(guid);
  }finally{await peer.close();}
});
test('返回缓存笔记先重新鉴权，撤权后不显示正文，退出后另一个账号不复用旧会话',async({page,request})=>{
  const owner=await person(request),reader=await person(request),other=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'返回权限隔离'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'缓存权限笔记 '+randomUUID().slice(0,8)},owner),body='需要重新授权的内容 '+randomUUID();
  const {prosemirrorJSONToYDoc}=await import('@tiptap/y-tiptap'),{schema,EDITOR_SCHEMA_VERSION}=await import('@anote/document-model'),Y=await import('yjs');
  const doc=prosemirrorJSONToYDoc(schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:body}]}]},'default');
  try{await api(request,'POST',`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')},owner);}finally{doc.destroy();}
  const sharing=await api(request,'GET',`documents/${note.id}/sharing`,undefined,owner);await api(request,'PATCH',`documents/${note.id}/sharing`,{visibility:'private',access_revision:sharing.access_revision,collaborators:[{user_id:reader.user.id,role:'viewer'}]},owner);
  await login(page,reader);await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('editor')).toContainText(body);await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','false');
  await page.getByRole('link',{name:'首页',exact:true}).click();await page.getByRole('button',{name:'分享给我',exact:true}).click();const button=page.locator('.note-open').filter({hasText:note.title});await expect(button).toBeVisible();
  const current=await api(request,'GET',`documents/${note.id}/sharing`,undefined,owner);await api(request,'PATCH',`documents/${note.id}/sharing`,{visibility:'private',access_revision:current.access_revision,collaborators:[]},owner);
  await page.evaluate(body=>{(window as any).__warmLeaked=false;const inspect=()=>{if([...document.querySelectorAll('[data-testid="editor"]')].some(editor=>editor.textContent?.includes(body)))(window as any).__warmLeaked=true;};new MutationObserver(inspect).observe(document,{subtree:true,childList:true,characterData:true});},body);
  const denied=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/documents/${note.id}`&&response.status()===403);await button.click();await denied;await expect(page.getByTestId('editor')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__warmLeaked)).toBe(false);
  await signOutWorkspace(page);await page.getByLabel('用户名',{exact:true}).fill(other.username);await page.getByLabel('密码',{exact:true}).fill(other.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.academic-workspace')).toBeVisible();await expect(page.getByTestId('editor')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__warmLeaked)).toBe(false);
});

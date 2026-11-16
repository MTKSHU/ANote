import {test,expect,_electron,type ElectronApplication} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {PersonalStore} from '../main/personal-store.mjs';

test('native local archive is durable and read-only, exports Markdown, restores and reopens its protected catalog',async()=>{
 expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');
 const root=path.resolve('artifacts/library-archive/native-'+randomUUID()),directory=root+'/notes',profile=root+'/profile';await fs.mkdir(directory,{recursive:true});await fs.mkdir(profile);
 const store=await new PersonalStore(directory).load();
 const api=async(route:string,method='GET',body?:any)=>{const url=new URL('/api/'+route,'http://local'),r=await store.respond(new Request(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),url);expect(r.ok,await r.clone().text()).toBe(true);return r.json();};
 const book=await api('spaces','POST',{kind:'personal',name:'本地归档验收'}),note=await api('documents','POST',{space_id:book.id,title:'本地原稿'}),doc=prosemirrorJSONToYDoc(schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'归档仍可阅读与导出的正文'}]}]},'default');
 try{await api('documents/'+note.id+'/local-state','PUT',{ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});}finally{doc.destroy();}
 const noteFile=await store.safe('notes/'+note.id+'.json');let before=await fs.readFile(noteFile);await store.close();await fs.writeFile(profile+'/personal-mode.json',JSON.stringify({directory}));
 let app:ElectronApplication|undefined;
 const executable=process.env.DESKTOP_EXECUTABLE;
 const launch=async()=>{const application=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:['--no-sandbox','--password-store=basic',...(executable?[]:['apps/desktop'])],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:'1'}});if(process.env.DESKTOP_EXPECTED_VERSION)expect(await application.evaluate(({app})=>app.getVersion())).toBe(process.env.DESKTOP_EXPECTED_VERSION);return application;};
 try{
  app=await launch();const page=await app.firstWindow();await page.getByRole('link',{name:'全部知识库',exact:true}).click();
  const card=page.locator('.library-card').filter({has:page.getByRole('heading',{name:book.name,exact:true})});await expect(card).toBeVisible();before=await fs.readFile(noteFile);await card.getByRole('button',{name:'管理知识库 '+book.name,exact:true}).click();await page.getByRole('dialog',{name:'管理知识库',exact:true}).getByRole('button',{name:'归档知识库',exact:true}).click();
  const confirm=page.getByRole('dialog',{name:'归档知识库',exact:true});await expect(confirm).toContainText('旧客户端将拒绝载入');await confirm.getByRole('button',{name:'确认归档',exact:true}).click();await expect(card).toHaveCount(0);await page.getByLabel('知识库状态',{exact:true}).selectOption('archived');await card.locator('.library-open').click();await expect(page.locator('.library-archive-notice')).toBeVisible();await page.locator('.note-open').filter({hasText:note.title}).click();
  const editor=page.getByTestId('editor');await expect(editor).toContainText('归档仍可阅读与导出的正文');await expect(editor).toHaveAttribute('contenteditable','false');await expect(page.locator('.document-info')).toContainText('知识库已归档');expect(await fs.readFile(noteFile)).toEqual(before);
  const file=root+'/archive.md';await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=(async()=>({canceled:false,filePath:file})) as any;},file);await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();await page.getByRole('button',{name:'导出 Markdown（.md）',exact:true}).click();await expect.poll(()=>fs.readFile(file,'utf8').catch(()=>'' )).toContain('归档仍可阅读与导出的正文');
  await page.getByRole('link',{name:'全部知识库',exact:true}).click();await card.getByRole('button',{name:'管理知识库 '+book.name,exact:true}).click();await page.getByRole('dialog',{name:'管理知识库',exact:true}).getByRole('button',{name:'恢复知识库',exact:true}).click();await page.getByRole('dialog',{name:'恢复知识库',exact:true}).getByRole('button',{name:'确认恢复',exact:true}).click();await page.getByLabel('知识库状态',{exact:true}).selectOption('active');await expect(card).toBeVisible();
  await app.close();app=undefined;const index=JSON.parse(await fs.readFile(directory+'/.anote/catalog.json','utf8'));expect(index.version).toBe(2);expect(index.spaces.find((item:any)=>item.id===book.id).archived).toBe(false);
  app=await launch();const reopened=await app.firstWindow();await expect(reopened.locator('.academic-workspace')).toBeVisible();await reopened.getByRole('link',{name:'全部知识库',exact:true}).click();await expect(reopened.locator('.library-card').filter({hasText:book.name})).toBeVisible();
 }finally{await app?.close();}
});

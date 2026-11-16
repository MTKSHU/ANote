import {test,expect,_electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PersonalStore} from '../main/personal-store.mjs';

test('changing English to Chinese saves local typing and retains user content',async()=>{
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');
  const root=path.resolve('artifacts/public-language/'+randomUUID()),directory=root+'/notes',profile=root+'/profile';
  await fs.mkdir(directory,{recursive:true});await fs.mkdir(profile);
  const store=await new PersonalStore(directory).load();
  const invoke=async(route:string,body:any)=>{const url=new URL('/api/'+route,'http://local');const response=await store.respond(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),url);expect(response.ok).toBe(true);return response.json();};
  const library=await invoke('spaces',{kind:'personal',name:'保留用户的知识库名称'}),note=await invoke('documents',{space_id:library.id,title:'中文标题 stays unchanged'});
  await store.close();await fs.writeFile(profile+'/personal-mode.json',JSON.stringify({directory}));
  const app=await _electron.launch({args:['--no-sandbox','--password-store=basic','apps/desktop','--document='+note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_LOCALE:'en',ANOTE_DESKTOP_TEST:'1'}});
  try{
    const page=await app.firstWindow();await expect(page.locator('html')).toHaveAttribute('lang','en');
    const editor=page.getByTestId('editor');await expect(editor).toHaveAttribute('contenteditable','true');
    await expect(page.getByLabel('Note title',{exact:true})).toHaveValue(note.title);
    await editor.locator('p').last().click();await page.keyboard.insertText('刚输入的中文 and unsaved English remain intact.');
    await page.locator('.workspace-account-menu summary').click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
    await page.getByRole('dialog',{name:'Settings',exact:true}).getByLabel('Interface language',{exact:true}).selectOption('zh-CN');
    await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(note.title);
    await expect(page.getByTestId('editor')).toContainText('刚输入的中文 and unsaved English remain intact.');
    const saved=JSON.parse(await fs.readFile(directory+'/.anote/notes/'+note.id+'.json','utf8'));expect(JSON.stringify(saved.snapshot)).toContain('刚输入的中文 and unsaved English remain intact.');
  }finally{await app.close();}
});

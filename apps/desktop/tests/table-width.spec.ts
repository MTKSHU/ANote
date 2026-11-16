import {test,expect,_electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {schema} from '@anote/document-model';
import {PersonalStore} from '../main/personal-store.mjs';

test('local desktop table sizing starts correctly, persists to disk and stays unchanged while typing',async()=>{
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');const root=path.resolve('artifacts/table-width/native-'+randomUUID()),directory=root+'/notes',profile=root+'/profile';await fs.mkdir(directory,{recursive:true});await fs.mkdir(profile);
  const store=await new PersonalStore(directory).load(),invoke=async(route:string,method='GET',body?:any)=>{const url=new URL('/api/'+route,'http://local'),response=await store.respond(new Request(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),url);expect(response.ok,await response.clone().text()).toBe(true);return response.json();};
  const book=await invoke('spaces','POST',{kind:'personal',name:'列宽本地验收'}),note=await invoke('documents','POST',{space_id:book.id,title:'本地列宽'}),snapshot={type:'doc',content:[{type:'table',attrs:{blockId:randomUUID()},content:[{type:'tableRow',content:['编号','较长的说明文字 '.repeat(20),'完成'].map(text=>({type:'tableCell',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]}]}))}]}]},doc=prosemirrorJSONToYDoc(schema,snapshot,'default');
  try{await invoke('documents/'+note.id+'/local-state','PUT',{ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});}finally{doc.destroy();}const file=await store.safe('notes/'+note.id+'.json');await store.close();await fs.writeFile(profile+'/personal-mode.json',JSON.stringify({directory}));
  const executable=process.env.DESKTOP_EXECUTABLE;
  const app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:['--no-sandbox','--password-store=basic',...(executable?[]:['apps/desktop']),'--document='+note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:'1'}});
  try{
    if(process.env.DESKTOP_EXPECTED_VERSION)expect(await app.evaluate(({app})=>app.getVersion())).toBe(process.env.DESKTOP_EXPECTED_VERSION);
    const page=await app.firstWindow(),editor=page.getByTestId('editor');await expect(editor).toHaveAttribute('contenteditable','true');await expect(editor).toContainText('较长的说明文字');
    const table=editor.locator('table').first(),cell=table.locator('td').first(),box=(await cell.boundingBox())!;await page.mouse.move(box.x+box.width-2,box.y+box.height/2);await expect(editor).toHaveClass(/resize-cursor/);await page.mouse.down();await page.mouse.move(box.x+box.width+50,box.y+box.height/2,{steps:6});await page.mouse.up();
    const get=async()=>JSON.parse(await fs.readFile(file,'utf8')).snapshot.content.find((n:any)=>n.type==='table');await expect.poll(async()=>(await get()).content[0].content[0].attrs.colwidth?.[0]||0).toBeGreaterThan(0);
    await cell.click({button:'right'});await page.getByRole('button',{name:'按内容调整列宽',exact:true}).click();await expect.poll(async()=>{const cells=(await get()).content[0].content;return (cells[1].attrs.colwidth?.[0]||0)>(cells[0].attrs.colwidth?.[0]||0);}).toBe(true);
    const saved=(await get()).content[0].content.map((c:any)=>c.attrs.colwidth);await cell.locator('p').click();await page.keyboard.press('End');await page.keyboard.insertText(' 继续写字');await expect.poll(async()=>(await get()).content[0].content[0].content[0].content[0].text).toContain('继续写字');expect((await get()).content[0].content.map((c:any)=>c.attrs.colwidth)).toEqual(saved);
    await cell.click({button:'right'});await page.getByRole('button',{name:'平均分配列宽',exact:true}).click();await expect.poll(async()=>{const w=(await get()).content[0].content.map((c:any)=>c.attrs.colwidth?.[0]||0);return Math.max(...w)-Math.min(...w);}).toBeLessThanOrEqual(1);
    await page.reload();await expect(page.getByTestId('editor')).toContainText('继续写字');const columns=await page.getByTestId('editor').locator('col').evaluateAll(cols=>cols.map(col=>col.getBoundingClientRect().width));expect(Math.max(...columns)-Math.min(...columns)).toBeLessThan(2);
  }finally{await app.close();}
});

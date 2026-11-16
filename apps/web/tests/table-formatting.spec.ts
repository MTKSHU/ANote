import {test,expect,type Page,type APIRequestContext,type Locator} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {MCP_TOOLSET_VERSION} from '@anote/sync-core/mcp-model';
import {api,login,chooseTheme} from './helpers';
import {person,connect,call,scopes} from './mcp-helpers';
const p=(text:string,attrs:any={})=>({type:'paragraph',attrs:{blockId:randomUUID(),...attrs},content:[{type:'text',text}]});
const cell=(text:string,type='tableCell',attrs:any={})=>({type,attrs,content:[p(text)]});
async function setup(page:Page,request:APIRequestContext,content:any[]){
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'排版交互验收'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'排版交互'},owner);
  await login(page,owner);await page.goto('/?doc='+note.id);const editor=page.getByTestId('editor');await expect(page.locator('.document-mode-toggle')).toBeEnabled();if(await page.locator('.document-mode-toggle').getAttribute('data-mode')==='read')await page.locator('.document-mode-toggle').click();await expect(editor).toHaveAttribute('contenteditable','true');
  await editor.evaluate((el,content)=>(el as any).editor.commands.setContent({type:'doc',content}),content);return {owner,book,note,editor};
}
async function point(block:Locator,offset:number){return block.evaluate((el,offset)=>{const text=el.firstChild!,range=document.createRange();range.setStart(text,offset);range.setEnd(text,offset+1);const rect=range.getBoundingClientRect();return {x:rect.left+1,y:rect.top+rect.height/2};},offset);}
async function selectRange(editor:Locator,from:number,to:number){await editor.evaluate((el,{from,to})=>(el as any).editor.chain().setTextSelection({from,to}).focus().run(),{from,to});}
async function snapshot(editor:Locator){return editor.evaluate(el=>(el as any).editor.getJSON());}
async function tableTools(page:Page){await page.getByRole('button',{name:'表格操作菜单',exact:true}).click();return page.getByRole('toolbar',{name:'表格操作',exact:true});}
async function vertical(page:Page,value:string){await page.getByRole('button',{name:'单元格垂直对齐',exact:true}).click();await page.getByRole('dialog',{name:'单元格垂直对齐设置'}).getByRole('button',{name:value,exact:true}).click();}
async function indent(page:Page,value:string){await page.getByRole('button',{name:/^段落格式：/}).click();await page.getByRole('menu',{name:'段落格式',exact:true}).getByRole('menuitemradio',{name:value,exact:true}).click();}

test('文字拖选松开前不展开工具或移动正文；跨格滑动保持文字意图，显式操作保留选区',async({page,request},info)=>{
  test.skip(info.project.name==='mobile','真实鼠标拖选在桌面验收；移动端另验排版与菜单');
  const {editor}=await setup(page,request,[...Array.from({length:6},()=>p('表前内容')), {type:'table',content:Array.from({length:20},(_,r)=>({type:'tableRow',content:[cell('文字选区从这里开始并且可以换行。'.repeat(8)),cell('相邻格 '+r),cell('第三格')]}))},p('表后内容')]);
  const row=editor.locator('tr').nth(3),text=row.locator('td p').first(),header=page.locator('.document-header');await text.scrollIntoViewIfNeeded();
  const before=(await header.boundingBox())!,beforeTable=(await row.boundingBox())!;
  for(const [a,b] of [[2,11],[15,4]]){
    const start=await point(text,a),end=await point(text,b);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:12});
    await expect(page.getByRole('group',{name:'表格选区工具'})).toHaveCount(0);await expect(editor.locator('.selectedCell')).toHaveCount(0);
    expect((await header.boundingBox())!.height).toBe(before.height);expect((await row.boundingBox())!.y).toBeCloseTo(beforeTable.y,0);
    await page.mouse.up();await expect(page.getByRole('toolbar',{name:'选区格式'})).toBeVisible();await expect(page.getByRole('toolbar',{name:'表格操作',exact:true})).toHaveCount(0);
    const selection=await editor.evaluate(el=>{const e=(el as any).editor;return {text:e.state.doc.textBetween(e.state.selection.from,e.state.selection.to),kind:e.state.selection.toJSON().type};});
    expect(selection.kind).toBe('text');expect(selection.text.length).toBe(Math.abs(b-a));expect((await header.boundingBox())!.height).toBe(before.height);
  }
  const touchPrevented=await text.evaluate(el=>!el.dispatchEvent(new PointerEvent('contextmenu',{pointerType:'touch',bubbles:true,cancelable:true})));expect(touchPrevented).toBe(false);await expect(page.getByRole('toolbar',{name:'表格操作',exact:true})).toHaveCount(0);
  const selected=await editor.evaluate(el=>{const s=(el as any).editor.state.selection;return {from:s.from,to:s.to};});
  const rangeEnd=await point(text,6);await page.mouse.click(rangeEnd.x,rangeEnd.y,{button:'right'});await expect(page.getByRole('toolbar',{name:'表格操作',exact:true})).toBeVisible();
  expect(await editor.evaluate(el=>{const s=(el as any).editor.state.selection;return {from:s.from,to:s.to};})).toEqual(selected);
  await page.keyboard.press('Escape');await page.keyboard.press('Shift+F10');await expect(page.getByRole('toolbar',{name:'表格操作',exact:true})).toBeVisible();
  expect(await editor.evaluate(el=>{const s=(el as any).editor.state.selection;return {from:s.from,to:s.to};})).toEqual(selected);
  await page.keyboard.press('Escape');const start=await point(text,3),neighbor=(await row.locator('td').nth(1).boundingBox())!;await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(neighbor.x+30,neighbor.y+25,{steps:16});await page.mouse.up();await expect(editor.locator('.selectedCell')).toHaveCount(0);expect(await editor.evaluate(el=>(el as any).editor.state.selection.toJSON().type)).toBe('text');
  await text.click();await tableTools(page);await page.getByRole('button',{name:'选择当前单元格',exact:true}).click();await row.locator('td').nth(1).click({modifiers:['Shift']});await expect(row.locator('.selectedCell')).toHaveCount(2);
  await page.screenshot({path:'artifacts/table-paragraph/text-selection.png'});
});

test('单元格顶部、居中和底部对齐独立于水平对齐，支持合并格、批量、撤销及持久化',async({page,request})=>{
  const {editor,note,owner}=await setup(page,request,[{type:'table',content:[{type:'tableRow',content:[cell('短表头','tableHeader'),{type:'tableHeader',content:[p('高表头'),p('第二行'),p('第三行')]}]},{type:'tableRow',content:[cell('短正文'),{type:'tableCell',content:[p('高正文'),p('第二行'),p('第三行')]}]},{type:'tableRow',content:[cell('合并格','tableCell',{colspan:2,background:'#dbeafe'})]}]},p('后续正文')]);
  const cells=editor.locator('th,td');await cells.first().locator('p').click();await tableTools(page);await vertical(page,'垂直居中');await expect(cells.first()).toHaveCSS('vertical-align','middle');
  await cells.nth(2).locator('p').click();await tableTools(page);await vertical(page,'底部对齐');await expect(cells.nth(2)).toHaveCSS('vertical-align','bottom');
  const gap=await cells.nth(2).evaluate(el=>{const c=el.getBoundingClientRect(),p=el.querySelector('p')!.getBoundingClientRect();return {top:p.top-c.top,bottom:c.bottom-p.bottom};});expect(gap.top).toBeGreaterThan(gap.bottom+10);
  await page.keyboard.press('ControlOrMeta+z');await expect(cells.nth(2)).toHaveCSS('vertical-align','top');await page.keyboard.press('ControlOrMeta+Shift+z');await expect(cells.nth(2)).toHaveCSS('vertical-align','bottom');
  await cells.last().locator('p').click();await tableTools(page);await vertical(page,'垂直居中');await expect(cells.last()).toHaveCSS('background-color','rgb(219, 234, 254)');await expect(cells.last()).toHaveAttribute('colspan','2');
  await page.getByRole('button',{name:'全选表格单元格',exact:true}).click();await vertical(page,'底部对齐');for(let i=0;i<5;i++)await expect(cells.nth(i)).toHaveCSS('vertical-align','bottom');
  await page.getByRole('toolbar',{name:'选区格式'}).getByRole('button',{name:'对齐',exact:true}).click();await page.getByRole('button',{name:'居中对齐',exact:true}).click();
  for(const node of (await snapshot(editor)).content[0].content.flatMap((r:any)=>r.content)){expect(node.attrs.verticalAlign).toBe('bottom');for(const p of node.content)expect(p.attrs.textAlign).toBe('center');}
  const html=await editor.evaluate(el=>(el as any).editor.getHTML());expect(html).toContain('vertical-align: bottom');
  await page.keyboard.press('ControlOrMeta+s');await expect.poll(async()=>JSON.stringify((await api(request,'GET','documents/'+note.id,undefined,owner)).snapshot)).toContain('"verticalAlign":"bottom"');await page.reload();await expect(editor.locator('th,td').first()).toHaveCSS('vertical-align','bottom');
  if(await page.locator('.document-mode-toggle').getAttribute('data-mode')==='edit')await page.getByRole('button',{name:'阅读',exact:true}).click();await expect(page.getByRole('button',{name:'表格操作菜单',exact:true})).toHaveCount(0);
  for(const theme of ['light','dark'] as const){const mobile=test.info().project.name==='mobile';if(mobile)await page.getByRole('button',{name:'展开侧边栏',exact:true}).click();await chooseTheme(page,theme);if(mobile)await page.getByRole('button',{name:'关闭导航',exact:true}).click();await expect(editor.locator('td').first()).toHaveCSS('vertical-align','bottom');await page.screenshot({path:`artifacts/table-paragraph/vertical-${theme}-${test.info().project.name}.png`});}
});

test('首行缩进按字号计算，批量与新段落继承，标题列表代码不受影响，打印保留排版',async({page,request})=>{
  await page.addInitScript(()=>{window.print=()=>{};});
  const {editor}=await setup(page,request,[p('正文首行缩进需要换行验证。'.repeat(12)),{...p('大字首行缩进需要换行验证。'.repeat(12)),content:[{type:'text',text:'大字首行缩进需要换行验证。'.repeat(12),marks:[{type:'textStyle',attrs:{fontSize:24}}]}]}, {type:'heading',attrs:{level:2},content:[{type:'text',text:'标题保持左侧'}]}, {type:'taskList',content:[{type:'taskItem',attrs:{checked:false},content:[p('列表保持原样')]}]},{type:'codeBlock',content:[{type:'text',text:'const code = 1'}]}]);
  const paragraphs=editor.locator(':scope > p'),defaultIndent=await paragraphs.first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)*2+'px');await paragraphs.first().click();await indent(page,'首行缩进 2 字符');await expect(paragraphs.first()).toHaveCSS('text-indent',defaultIndent);await expect(paragraphs.nth(1)).toHaveCSS('text-indent','0px');
  const firstSize=await editor.evaluate(el=>(el as any).editor.state.doc.firstChild.nodeSize);const secondSize=await editor.evaluate(el=>(el as any).editor.state.doc.child(1).nodeSize);
  await selectRange(editor,1,firstSize+secondSize-1);await page.getByRole('toolbar',{name:'选区格式'}).getByRole('button',{name:'首行缩进',exact:true}).click();await page.getByRole('dialog',{name:'首行缩进设置'}).getByRole('button',{name:'首行缩进 2 字符',exact:true}).click();await expect(paragraphs.nth(1)).toHaveCSS('text-indent','48px');
  const geometry=await paragraphs.nth(1).evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const rects=[...range.getClientRects()].filter(r=>r.width>0),left=el.getBoundingClientRect().left;return rects.map(r=>({x:r.left-left,y:r.top}));});expect(geometry.some(r=>Math.abs(r.x-48)<1)).toBe(true);expect(geometry.some(r=>Math.abs(r.x)<1)).toBe(true);
  await selectRange(editor,firstSize+secondSize-1,firstSize+secondSize-1);await page.keyboard.press('Enter');expect((await snapshot(editor)).content[2].attrs.firstLineIndent).toBe(2);await page.keyboard.insertText('继承缩进的新段落');
  await paragraphs.nth(2).click();await indent(page,'取消首行缩进');await expect(paragraphs.nth(2)).toHaveCSS('text-indent','0px');expect((await snapshot(editor)).content[2].attrs.firstLineIndent).toBeUndefined();
  await editor.locator('h2').click();await page.getByRole('button',{name:/^段落格式：/}).click();await expect(page.getByRole('menuitemradio',{name:'首行缩进 2 字符',exact:true})).toBeDisabled();await page.keyboard.press('Escape');
  await selectRange(editor,1,(await editor.evaluate(el=>(el as any).editor.state.doc.content.size))-1);await page.getByRole('toolbar',{name:'选区格式'}).getByRole('button',{name:'首行缩进',exact:true}).click();await page.getByRole('button',{name:'首行缩进 2 字符',exact:true}).click();await expect(editor.locator('li p')).toHaveCSS('text-indent','0px');expect((await snapshot(editor)).content.find((n:any)=>n.type==='heading').attrs.firstLineIndent).toBeUndefined();
  await page.keyboard.press('ControlOrMeta+s');await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();await page.getByRole('button',{name:'打印／保存 PDF',exact:true}).click();const frame=page.frameLocator('iframe[data-note-print="true"]');await expect(frame.locator('main>p').first()).toHaveCSS('text-indent',/29\.33/);await expect(frame.locator('main>p').nth(1)).toHaveCSS('text-indent','48px');await expect(frame.locator('li p')).toHaveCSS('text-indent','0px');
  await page.locator('iframe[data-note-print="true"]').evaluate(el=>(el as HTMLIFrameElement).contentWindow!.dispatchEvent(new Event('afterprint')));await page.reload();await expect.poll(()=>paragraphs.first().evaluate(el=>parseFloat(getComputedStyle(el).textIndent)/parseFloat(getComputedStyle(el).fontSize))).toBe(2);await expect(paragraphs.nth(1)).toHaveCSS('text-indent','48px');
});

test('MCP 新排版规则可复用有效令牌发现和写入；旧 schema 与非法格式被拒绝',async({request},info)=>{
  test.skip(info.project.name==='mobile','协议与视口无关');const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'新格式MCP'},owner),token=await api(request,'POST','me/integrations/tokens',{name:'排版验证',scopes:scopes.split(' ')},owner);
  let client=await connect(token.token);try{
    expect(client.getServerVersion()?.version).toBe(MCP_TOOLSET_VERSION);const rules=await call(client,'get_editor_rules');expect(rules.schema_version).toBe(9);expect(rules.formatting.tableCell.verticalAlign.values).toEqual(['top','middle','bottom']);await call(client,'prepare_changes',{schema_version:8,library_id:book.id,operations:[]},409);
    await client.close();client=await connect(token.token);const change=await call(client,'prepare_changes',{schema_version:EDITOR_SCHEMA_VERSION,library_id:book.id,title:'两种排版',operations:[{action:'insert',node:p('MCP首行',{firstLineIndent:2})},{action:'insert',node:{type:'table',content:[{type:'tableRow',content:[cell('居中','tableHeader',{verticalAlign:'middle'})]}]}}]});const applied=await call(client,'apply_changes',{change_id:change.change_id,preview_hash:change.preview_hash,operation_id:randomUUID()}),read=await call(client,'read_note',{note_id:applied.doc_id||applied.note_id});expect(JSON.stringify(read.blocks)).toContain('"firstLineIndent":2');expect(JSON.stringify(read.blocks)).toContain('"verticalAlign":"middle"');
    for(const attrs of [{firstLineIndent:3},{firstLineIndent:'2em'}])await call(client,'prepare_changes',{schema_version:9,library_id:book.id,operations:[{action:'insert',node:p('无效',attrs)}]},400);
    await call(client,'prepare_changes',{schema_version:9,library_id:book.id,operations:[{action:'insert',node:{type:'table',content:[{type:'tableRow',content:[cell('无效','tableCell',{verticalAlign:'center'})]}]}}]},400);
  }finally{await client.close();await api(request,'DELETE','me/integrations/'+token.id,undefined,owner);}
});

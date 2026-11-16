import {test,expect,type APIRequestContext,type Browser,type Page,type Locator} from '@playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import {api,login} from './helpers';
import {person} from './mcp-helpers';

const paragraph=(text:string)=>({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]});
const editor=(page:Page)=>page.getByTestId('editor');
const paragraphs=(page:Page)=>editor(page).locator(':scope > p');
async function paragraphText(page:Page,expected:string[]){await expect.poll(()=>editor(page).evaluate(dom=>{const result:string[]=[];(dom as any).editor.state.doc.forEach((node:any)=>{if(node.type.name==='paragraph')result.push(node.textContent);});return result;})).toEqual(expected);}
async function highlightedText(root:Locator,annotation:any){
  // Collaboration carets are view widgets, not document text. A widget may
  // also split an inline decoration into multiple DOM spans for one range.
  await expect.poll(()=>root.locator(`[data-comment-id="${annotation.id}"]`).evaluateAll(nodes=>nodes.map(node=>{const copy=node.cloneNode(true) as HTMLElement;copy.querySelectorAll('.collaboration-carets__caret,.collaboration-cursor__caret').forEach(caret=>caret.remove());return copy.textContent||'';}).join(''))).toBe(annotation.quote);
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function setup(page:Page,request:APIRequestContext,content:any[]){
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'位置迁移集成资料'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'结构编辑与批注'},owner);
  await login(page,owner);await page.goto('/?doc='+note.id);await expect(editor(page)).toHaveAttribute('contenteditable','true');
  await editor(page).evaluate((dom,content)=>(dom as any).editor.commands.setContent({type:'doc',content}),content);
  await expect(page.getByTestId('document-sync')).toHaveText('已同步');
  return {owner,book,note};
}
async function selection(page:Page,quote:string,collapsed=false){
  await page.bringToFront();
  const expected=await editor(page).evaluate((dom,{quote,collapsed})=>{
    const instance=(dom as any).editor,matches:{pos:number;text:string}[]=[];
    instance.state.doc.descendants((node:any,pos:number)=>{if(node.isTextblock&&node.textContent.includes(quote))matches.push({pos,text:node.textContent});});
    if(matches.length!==1)throw new Error('Expected one quoted paragraph, received '+matches.length);
    const from=matches[0].pos+1+matches[0].text.indexOf(quote),to=collapsed?from:from+quote.length;instance.chain().setTextSelection({from,to}).focus().run();return {from,to};
  },{quote,collapsed});
  await expect(editor(page)).toBeFocused();
  await expect.poll(()=>editor(page).evaluate(dom=>{const {from,to}=(dom as any).editor.state.selection;return {from,to};})).toEqual(expected);
  if(!collapsed)await expect.poll(()=>page.evaluate(()=>getSelection()?.toString())).toBe(quote);
}
async function stopCapture(page:Page){
  await editor(page).evaluate(dom=>{const instance=(dom as any).editor,plugin=instance.state.plugins.find((plugin:any)=>plugin.key.startsWith('y-undo'));const manager=plugin?.getState(instance.state)?.undoManager;if(!manager)throw new Error('Expected the real collaboration undo manager');manager.stopCapturing();});
}
async function comment(page:Page,request:APIRequestContext,f:any,quote:string){
  await selection(page,quote);await page.keyboard.press('ControlOrMeta+Alt+m');
  await expect(page.getByLabel('评论原文',{exact:true})).toHaveText(quote);await page.getByLabel('评论内容',{exact:true}).fill('结构变化后仍应定位这段文字');await page.getByRole('button',{name:'添加评论',exact:true}).click();
  const card=page.locator('.annotation-card:not(.annotation-draft)');await expect(card).toHaveCount(1);const id=(await card.getAttribute('data-comment-id'))!;
  const record=(await api(request,'GET',`documents/${f.note.id}/comments`,undefined,f.owner)).find((item:any)=>item.id===id);expect(record.anchor.from).toBeTruthy();expect(record.anchor.to).toBeTruthy();
  return {id,anchor:record.anchor,quote};
}
async function visibleAnchor(page:Page,annotation:any){
  if(!await page.locator('.annotation-rail').count())await page.locator('.document-actions').getByRole('button',{name:'评论',exact:true}).click();
  const card=page.locator(`.annotation-card[data-comment-id="${annotation.id}"]`);await expect(card.locator('blockquote')).toHaveText(annotation.quote);await expect(card.getByRole('button',{name:'定位原文',exact:true})).toBeEnabled();
  await highlightedText(editor(page),annotation);
}
async function storedAnchor(request:APIRequestContext,f:any,annotation:any,orphaned=false){
  await expect.poll(async()=>{const record=(await api(request,'GET',`documents/${f.note.id}/comments`,undefined,f.owner)).find((item:any)=>item.id===annotation.id);expect(record.anchor).toEqual(annotation.anchor);return record.resolvedAnchor;}).toMatchObject(orphaned?{orphaned:true}:{orphaned:false,text:annotation.quote});
}
async function peerPage(browser:Browser,request:APIRequestContext,f:any){
  const peer=await person(request),sharing=await api(request,'GET',`documents/${f.note.id}/sharing`,undefined,f.owner);await api(request,'PATCH',`documents/${f.note.id}/sharing`,{visibility:'private',access_revision:sharing.access_revision,collaborators:[{user_id:peer.user.id,role:'editor'}]},f.owner);
  const context=await browser.newContext();try{const page=await context.newPage();await login(page,peer);await page.goto('/?doc='+f.note.id);await expect(editor(page)).toHaveAttribute('contenteditable','true');return {page,context};}catch(error){await context.close();throw error;}
}

test('选区批注跨段落拆分合并、撤销重做及另一协作者编辑后保持原文与定位',async({page,request,browser})=>{
  const quote='核心结论不能丢失',prefix='背景说明：',target=prefix+quote+'；结束。',f=await setup(page,request,[paragraph('实验开头。'),paragraph(target),paragraph('实验结尾。')]),annotation=await comment(page,request,f,quote),peer=await peerPage(browser,request,f);
  try{
    await visibleAnchor(peer.page,annotation);await selection(page,quote,true);await stopCapture(page);await page.keyboard.press('Enter');await stopCapture(page);
    for(const current of [page,peer.page]){await paragraphText(current,['实验开头。',prefix,quote+'；结束。','实验结尾。']);await visibleAnchor(current,annotation);}await storedAnchor(request,f,annotation);
    await selection(page,quote,true);await stopCapture(page);await page.keyboard.press('Backspace');await stopCapture(page);
    for(const current of [page,peer.page]){await paragraphText(current,['实验开头。',target,'实验结尾。']);await visibleAnchor(current,annotation);}await storedAnchor(request,f,annotation);
    await page.keyboard.press('ControlOrMeta+z');await expect(paragraphs(page)).toHaveCount(4);await visibleAnchor(page,annotation);await page.keyboard.press('ControlOrMeta+Shift+z');await expect(paragraphs(page)).toHaveCount(3);await visibleAnchor(page,annotation);
    for(const current of [page,peer.page])await paragraphText(current,['实验开头。',target,'实验结尾。']);
    await selection(peer.page,quote,true);await peer.page.keyboard.insertText('协作补充：');
    for(const current of [page,peer.page]){await paragraphText(current,['实验开头。',prefix+'协作补充：'+quote+'；结束。','实验结尾。']);await visibleAnchor(current,annotation);}await storedAnchor(request,f,annotation);
    await page.reload();await paragraphText(page,['实验开头。',prefix+'协作补充：'+quote+'；结束。','实验结尾。']);await visibleAnchor(page,annotation);await storedAnchor(request,f,annotation);
  }finally{await peer.context.close();}
});

test('同一段落节点跨块移动和多步复制不混淆批注，撤销重做与协作者重开保留唯一锚点',async({page,request,browser},testInfo)=>{
  const quote='移动与复制的唯一批注',target='目标：'+quote+'。',f=await setup(page,request,[paragraph('前置段。'),paragraph(target),paragraph('后置段。')]),annotation=await comment(page,request,f,quote),peer=await peerPage(browser,request,f);
  try{
    await visibleAnchor(peer.page,annotation);await stopCapture(page);
    const moved=await editor(page).evaluate((dom,text)=>{const instance=(dom as any).editor;let found:any;instance.state.doc.forEach((node:any,pos:number)=>{if(node.textContent===text)found={node,pos};});if(!found)throw new Error('Expected moving paragraph');const transaction=instance.state.tr.delete(found.pos,found.pos+found.node.nodeSize);transaction.insert(transaction.doc.content.size,found.node);const reused=transaction.doc.lastChild===found.node;instance.view.dispatch(transaction);instance.view.focus();return {reused,steps:transaction.steps.length};},target);expect(moved).toEqual({reused:true,steps:2});await stopCapture(page);
    for(const current of [page,peer.page]){await paragraphText(current,['前置段。','后置段。',target]);await visibleAnchor(current,annotation);await highlightedText(paragraphs(current).last(),annotation);}await storedAnchor(request,f,annotation);
    await page.keyboard.press('ControlOrMeta+z');await paragraphText(page,['前置段。',target,'后置段。']);await visibleAnchor(page,annotation);await page.keyboard.press('ControlOrMeta+Shift+z');await paragraphText(page,['前置段。','后置段。',target]);await visibleAnchor(page,annotation);
    await stopCapture(page);const copied=await editor(page).evaluate((dom,text)=>{const instance=(dom as any).editor;let source:any;instance.state.doc.forEach((node:any)=>{if(node.textContent===text)source=node;});if(!source)throw new Error('Expected copying paragraph');const transaction=instance.state.tr.insert(0,source);transaction.insert(transaction.doc.content.size,source);instance.view.dispatch(transaction);instance.view.focus();return {steps:transaction.steps.length};},target);expect(copied.steps).toBe(2);await stopCapture(page);
    for(const [role,current] of [['owner',page],['peer',peer.page]] as const){await test.step('copy '+role+' anchor',async()=>{
      await paragraphText(current,[target,'前置段。','后置段。',target,target]);
      const state=await editor(current).evaluate((dom,id)=>{const instance=(dom as any).editor,syncPlugin=instance.state.plugins.find((plugin:any)=>plugin.key.startsWith('y-sync')),sync=syncPlugin?.getState(instance.state),annotations=instance.state.plugins.find((plugin:any)=>plugin.key.startsWith('academicAnnotations'));return {document:instance.getJSON(),composing:instance.view.composing,sync:{isChangeOrigin:sync?.isChangeOrigin,migration:!!sync?.positionMigration,syncedDocMatches:sync?.binding.syncedDoc===instance.state.doc},domHighlights:Array.from(dom.querySelectorAll(`[data-comment-id="${id}"]`)).map((node:any)=>({text:node.textContent,html:node.outerHTML})),freshDecorations:annotations?.props.decorations(instance.state)?.find().map((range:any)=>({from:range.from,to:range.to,text:instance.state.doc.textBetween(range.from,range.to,'\n')}))};},annotation.id);
      const record=(await api(request,'GET',`documents/${f.note.id}/comments`,undefined,f.owner)).find((item:any)=>item.id===annotation.id);
      await testInfo.attach('copy-'+role+'-anchor-state',{body:JSON.stringify({state,record,originalAnchor:annotation.anchor}),contentType:'application/json'});
      await visibleAnchor(current,annotation);await highlightedText(paragraphs(current).nth(3),annotation);await expect(paragraphs(current).first().locator(`[data-comment-id="${annotation.id}"]`)).toHaveCount(0);await expect(paragraphs(current).last().locator(`[data-comment-id="${annotation.id}"]`)).toHaveCount(0);
    });}await storedAnchor(request,f,annotation);
    await page.keyboard.press('ControlOrMeta+z');await paragraphText(page,['前置段。','后置段。',target]);await visibleAnchor(page,annotation);await page.keyboard.press('ControlOrMeta+Shift+z');await expect(paragraphs(page)).toHaveCount(5);await visibleAnchor(page,annotation);
    await peer.page.reload();await paragraphText(peer.page,[target,'前置段。','后置段。',target,target]);await visibleAnchor(peer.page,annotation);await highlightedText(paragraphs(peer.page).nth(3),annotation);await storedAnchor(request,f,annotation);
  }finally{await peer.context.close();}
});

test('整篇只有2000项TODO时全选删除补默认空段，撤销完整还原正文、勾选和批注锚点',async({page,request},testInfo)=>{
  const tasks={type:'taskList',attrs:{blockId:randomUUID()},content:Array.from({length:2000},(_,index)=>({type:'taskItem',attrs:{checked:index%3===0},content:[paragraph('任务 '+index+' '+('需要保留的协作正文 abcdefghijklmnop。').repeat(10))]}))},f=await setup(page,request,[tasks]);
  const initialShape=await editor(page).evaluate(dom=>{const content:any[]=[];(dom as any).editor.state.doc.forEach((node:any)=>content.push({type:node.type.name,empty:node.content.size===0}));return content;});expect(initialShape.filter(node=>node.type==='taskList')).toHaveLength(1);expect(initialShape.filter(node=>node.type!=='taskList').every(node=>node.type==='paragraph'&&node.empty)).toBe(true);
  const beforeHash=hash(await editor(page).evaluate(dom=>(dom as any).editor.getJSON())),annotation=await comment(page,request,f,'任务 1800');
  await stopCapture(page);await editor(page).evaluate(dom=>(dom as any).editor.commands.focus('start'));await page.keyboard.press('ControlOrMeta+a');
  await expect.poll(()=>editor(page).evaluate(dom=>{const instance=(dom as any).editor;return instance.state.selection.from===0&&instance.state.selection.to===instance.state.doc.content.size;})).toBe(true);
  await editor(page).evaluate(()=>{(window as any).__positionMigrationDeleteFrame=null;document.addEventListener('keydown',()=>{const start=performance.now();requestAnimationFrame(()=>(window as any).__positionMigrationDeleteFrame=performance.now()-start);},{once:true,capture:true});});await page.keyboard.press('Backspace');
  await expect(editor(page).locator('input[type="checkbox"]')).toHaveCount(0);await expect(paragraphs(page)).toHaveCount(1);await expect(paragraphs(page)).toHaveText('');await expect.poll(()=>page.evaluate(()=>(window as any).__positionMigrationDeleteFrame)).not.toBeNull();
  const deletionFrameMs=await page.evaluate(()=>(window as any).__positionMigrationDeleteFrame);expect(deletionFrameMs).toBeLessThan(3000);await storedAnchor(request,f,annotation,true);
  await page.keyboard.press('ControlOrMeta+z');await expect(editor(page).locator('input[type="checkbox"]')).toHaveCount(2000);expect(hash(await editor(page).evaluate(dom=>(dom as any).editor.getJSON()))).toBe(beforeHash);await visibleAnchor(page,annotation);await storedAnchor(request,f,annotation);
  await testInfo.attach('whole-document-todo-delete',{body:JSON.stringify({tasks:2000,initialShape,deletionFrameMs,defaultEmptyParagraph:true,undoSnapshotHashPreserved:true,annotationRestored:true}),contentType:'application/json'});
});

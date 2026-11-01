import {test,expect,type Page,type APIRequestContext} from "@playwright/test";
import {api,login,chooseTheme,editMapNode} from "./helpers";
import {person} from "./mcp-helpers";
const nodes=[
  {id:"root",parentId:null,x:320,y:180,text:"中心主题"},
  {id:"one",parentId:"root",x:560,y:100,text:"第一分支"},
  {id:"two",parentId:"root",x:560,y:260,text:"第二分支"},
  {id:"three",parentId:"one",x:800,y:100,text:"分支细节"},
];
async function setup(page:Page,request:APIRequestContext){
  const owner=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"导图交互验证"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"思维导图交互"},owner);
  await login(page,owner);await page.goto('/?doc='+note.id);await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','true');
  await page.getByTestId('editor').evaluate((el,items)=>(el as any).editor.commands.setContent({type:'doc',content:[{type:'mindMap',content:items.map(({text,...attrs})=>({type:'mindMapItem',attrs,content:[{type:'text',text}]}))},{type:'paragraph'}]}),nodes);
  const map=page.getByTestId('mind-map');await expect(map.locator('.mind-map-node')).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');
  return {owner,note,map,canvas:map.locator('.mind-map-viewport')};
}
test('连线为无填充的细贝塞尔曲线，明暗主题均正确，移除历史说明',async({page,request})=>{
  const{map}=await setup(page,request);const edges=map.locator('.mind-map-edges > path');await expect(edges).toHaveCount(3);
  for(const theme of ['light','dark'] as const){
    await chooseTheme(page,theme);await expect(page.locator('html')).not.toHaveClass(/theme-changing/);
    for(const edge of await edges.all()){await expect(edge).toHaveCSS('fill','none');expect(await edge.evaluate(el=>getComputedStyle(el).stroke)).not.toBe('none');await expect(edge).toHaveAttribute('vector-effect','non-scaling-stroke');await expect(edge).toHaveAttribute('d',/ C /);expect(await edge.evaluate(el=>(el as SVGPathElement).getTotalLength())).toBeGreaterThan(50);}
    await expect(edges.first()).toHaveAttribute('d',/^M 400 180 C .* 480 100$/);
    await map.screenshot({path:`artifacts/web/mindmap-${theme}.png`});
  }
  await page.locator('.document-actions').getByRole('button',{name:'历史版本',exact:true}).click();
  await expect(page.locator('.history-explanation')).toHaveCount(0);await expect(page.getByRole('tab',{name:'自动记录',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'命名版本',exact:true})).toBeVisible();
});
test('节点默认展示文字；空格和双击编辑，组合输入不添加节点，Tab/Enter 创建分支',async({page,request})=>{
  const{map}=await setup(page,request);const root=map.locator('[data-node-id="root"]');
  await expect(map.locator('input')).toHaveCount(0);await expect(map.locator('.mind-map-drag')).toHaveCount(0);
  await root.click();await expect(map.locator('input')).toHaveCount(0);await page.keyboard.press('Space');await expect(root.locator('input')).toBeFocused();
  await root.locator('input').fill('空格进入编辑');await root.locator('input').press('Escape');await expect(root.locator('.mind-map-node-label')).toHaveText('空格进入编辑');
  await editMapNode(map,0,'双击修改');await root.dblclick();const input=root.locator('input');
  await input.dispatchEvent('compositionstart',{data:''});await input.fill('shuru');await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});await expect(map.locator('.mind-map-node')).toHaveCount(4);await input.fill('输入');await input.dispatchEvent('compositionend',{data:'输入'});await input.press('Escape');
  await expect(root.locator('.mind-map-node-label')).toHaveText('输入');await root.click();await page.keyboard.press('Tab');await expect(map.locator('.mind-map-node')).toHaveCount(5);await expect(map.locator('input')).toBeFocused();await map.locator('input').fill('新增子节点');await map.locator('input').press('Enter');await expect(map.locator('.mind-map-node')).toHaveCount(6);await expect(map.locator('input')).toBeFocused();await map.locator('input').press('Escape');
  const snapshot=await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON().content.find((n:any)=>n.type==='mindMap'));expect(snapshot.content.at(-1).attrs.parentId).toBe(snapshot.content.at(-2).attrs.parentId);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');await page.reload();await expect(map.locator('[data-node-id="root"] .mind-map-node-label')).toHaveText('输入');await expect(map.locator('input')).toHaveCount(0);
});
test('滚轮围绕指针缩放，空白处拖动画布，缩放后节点拖动坐标准确且持久化',async({page,request})=>{
  const{owner,note,map,canvas}=await setup(page,request);const hash=(await api(request,'GET',`documents/${note.id}`,undefined,owner)).hash;
  const rect=(await canvas.boundingBox())!,x=Math.round(rect.x+rect.width*.72),y=Math.round(rect.y+rect.height*.8);
  const view=()=>canvas.evaluate(el=>({x:Number((el as HTMLElement).dataset.panX),y:Number((el as HTMLElement).dataset.panY),zoom:Number((el as HTMLElement).dataset.zoom)}));
  const before=await view();await page.mouse.move(x,y);await page.mouse.wheel(0,-180);await expect.poll(async()=>(await view()).zoom).toBeGreaterThan(before.zoom);
  const after=await view();expect((x-rect.x-after.x)/after.zoom).toBeCloseTo((x-rect.x-before.x)/before.zoom,3);expect((y-rect.y-after.y)/after.zoom).toBeCloseTo((y-rect.y-before.y)/before.zoom,3);
  await page.mouse.move(rect.x+20,rect.y+rect.height-20);await page.mouse.down();await page.mouse.move(rect.x+100,rect.y+rect.height-65,{steps:8});await page.mouse.up();const panned=await view();expect(panned.x-after.x).toBeCloseTo(80,0);expect(panned.y-after.y).toBeCloseTo(-45,0);
  expect((await api(request,'GET',`documents/${note.id}`,undefined,owner)).hash).toBe(hash);
  await map.getByRole('button',{name:'适应思维导图画布',exact:true}).click();await map.getByRole('button',{name:'放大思维导图',exact:true}).click();
  const moving=map.locator('[data-node-id="two"]'),box=(await moving.boundingBox())!,scale=(await view()).zoom;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+55,box.y+box.height/2-25,{steps:10});await page.mouse.up();
  const result=await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON().content.find((n:any)=>n.type==='mindMap').content.find((n:any)=>n.attrs.id==='two').attrs);
  expect(result.x).toBeCloseTo(560+55/scale,0);expect(result.y).toBeCloseTo(260-25/scale,0);await expect(map.locator('input')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');await expect(page.getByTestId('document-sync')).toHaveText('已保存');await page.reload();const restored=await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON().content.find((n:any)=>n.type==='mindMap').content.find((n:any)=>n.attrs.id==='two').attrs);expect(restored).toEqual(result);
});
test('全屏按钮进入真实浏览器全屏，按钮或 Esc 退出，保留视图与正文',async({page,request})=>{
  const{map,canvas}=await setup(page,request);const normal=(await canvas.boundingBox())!.height;
  await map.getByRole('button',{name:'全屏查看思维导图',exact:true}).click();await expect.poll(()=>page.evaluate(()=>document.fullscreenElement?.className)).toBe('mind-map-shell');
  const box=(await map.locator('.mind-map-shell').boundingBox())!;expect(box.width).toBe(page.viewportSize()!.width);expect(box.height).toBe(page.viewportSize()!.height);expect((await canvas.boundingBox())!.height).toBeGreaterThan(normal);
  await map.locator('.mind-map-shell').screenshot({path:'artifacts/web/mindmap-fullscreen.png'});await map.getByRole('button',{name:'退出思维导图全屏',exact:true}).click();await expect.poll(()=>page.evaluate(()=>document.fullscreenElement===null)).toBe(true);
  await map.getByRole('button',{name:'全屏查看思维导图',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);await expect(canvas).toBeFocused();await page.keyboard.press('Escape');await expect.poll(()=>page.evaluate(()=>document.fullscreenElement===null)).toBe(true);await expect(map.locator('.mind-map-node')).toHaveCount(4);
});
test('只读成员可缩放、平移和全屏，不能编辑或移动节点，浏览操作不改变笔记',async({page,request,browser})=>{
  const{owner,note}=await setup(page,request),viewer=await person(request),sharing=await api(request,'GET',`documents/${note.id}/sharing`,undefined,owner);
  await api(request,'PATCH',`documents/${note.id}/sharing`,{visibility:'private',access_revision:sharing.access_revision,collaborators:[{user_id:viewer.user.id,role:'viewer'}]},owner);
  const hash=(await api(request,'GET',`documents/${note.id}`,undefined,owner)).hash,context=await browser.newContext();
  try{const peer=await context.newPage();await login(peer,viewer);await peer.goto('/?doc='+note.id);const map=peer.getByTestId('mind-map'),canvas=map.locator('.mind-map-viewport');await expect(map.locator('.mind-map-node')).toHaveCount(4);await map.locator('.mind-map-node').first().dblclick();await peer.keyboard.press('Space');await expect(map.locator('input')).toHaveCount(0);await expect(map.getByRole('button',{name:'添加子节点',exact:true})).toHaveCount(0);
    const rect=(await canvas.boundingBox())!;await peer.mouse.move(rect.x+20,rect.y+rect.height-20);await peer.mouse.wheel(0,-100);await expect.poll(async()=>Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(1);await peer.mouse.down();await peer.mouse.move(rect.x+60,rect.y+rect.height-55);await peer.mouse.up();
    await map.getByRole('button',{name:'全屏查看思维导图',exact:true}).click();await expect.poll(()=>peer.evaluate(()=>!!document.fullscreenElement)).toBe(true);await map.getByRole('button',{name:'退出思维导图全屏',exact:true}).click();expect((await api(request,'GET',`documents/${note.id}`,undefined,owner)).hash).toBe(hash);
  }finally{await context.close();}
});

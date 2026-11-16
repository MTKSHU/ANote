import {test,expect,type Page} from "@playwright/test";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";

let script="",css="";
test.beforeAll(async()=>{
  const result=await build({
    stdin:{resolveDir:fileURLToPath(new URL("../../../",import.meta.url)),loader:"tsx",contents:`
      import React,{useState} from "react";
      import {createRoot} from "react-dom/client";
      import "./apps/desktop/renderer/ui-system.css";
      import {WorkspaceAccountMenu} from "./apps/desktop/renderer/workspace-account-menu";
      const calls=[];let gate=null;let patch;
      function App(){
        const [state,setState]=useState({native:true,local:true,scope:"personal",switchingWorkspace:false,teams:[{id:"team-a",name:"服务端团队 A"}]});patch=value=>setState(old=>({...old,...value}));
        async function choose(value){calls.push(value);if(gate)await gate.promise;setState(old=>({...old,local:value==="local",scope:value==="local"?old.scope:value}));}
        return <WorkspaceAccountMenu {...state} name="Alice" email="alice@example.test" requests={2} href={page=>"?page="+page} onFriends={()=>calls.push("friends")} onTeams={()=>calls.push("teams")} onSettings={()=>calls.push("settings")} onLogout={()=>calls.push("logout")} onCheckUpdates={()=>calls.push("updates")} onScope={choose} onLocalMode={()=>choose("local")} onWorkspaceOpen={()=>calls.push("open")} onWorkspaceError={error=>calls.push(error.message)}/>;
      }
      window.__accountTest={calls,patch:value=>patch(value),defer:()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});gate={promise,resolve,reject};},finish:error=>{const prior=gate;gate=null;if(error)prior.reject(new Error(error));else prior.resolve();}};
      createRoot(document.getElementById("root")).render(<App/>);
    `},
    bundle:true,platform:"browser",format:"iife",write:false,outfile:"account-menu-test.js",define:{"process.env.NODE_ENV":'"test"'},
  });
  script=result.outputFiles.find(file=>file.path.endsWith(".js"))!.text;
  css=result.outputFiles.find(file=>file.path.endsWith(".css"))!.text;
});
async function mount(page:Page){
  await page.setContent('<style>:root{--surface:#fff;--line:#ddd;--ink:#222;--accent:#3262dd;--soft:#f5f6fa}body{margin:0;font-family:sans-serif}#root{position:absolute;right:20px;top:10px}button{font:inherit;cursor:pointer}</style><main id="root"></main><button id="outside" style="margin-top:400px">外部按钮</button>');
  await page.addStyleTag({content:css});await page.addScriptTag({content:script});
  await expect(page.getByRole("button",{name:"用户菜单",exact:true})).toBeVisible();
}
async function openChoices(page:Page){
  await page.getByRole("button",{name:"用户菜单",exact:true}).click();await page.getByRole("menuitem",{name:"工作空间切换",exact:true}).click();
  return page.getByRole("menu",{name:"工作空间切换",exact:true});
}
test("本地模式区分服务器个人与团队，展开刷新不阻塞已有缓存",async({page})=>{
  await mount(page);const choices=await openChoices(page);
  await expect(choices.getByRole("menuitemradio",{name:"本地模式",exact:true})).toHaveAttribute("aria-checked","true");
  await expect(choices.getByRole("menuitemradio",{name:"个人",exact:true})).toHaveAttribute("aria-checked","false");
  await expect(choices.getByRole("menuitemradio",{name:"服务端团队 A",exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as any).__accountTest.calls)).toEqual(["open"]);
  await choices.getByRole("menuitemradio",{name:"服务端团队 A",exact:true}).click();
  await expect(choices).toHaveCount(0);
  const reopened=await openChoices(page);
  await expect(reopened.getByRole("menuitemradio",{name:"服务端团队 A",exact:true})).toHaveAttribute("aria-checked","true");
  await expect(reopened.getByRole("menuitemradio",{name:"本地模式",exact:true})).toHaveAttribute("aria-checked","false");
});
test("异步工作空间切换防止重复，失败保留原状态并允许重试",async({page})=>{
  await mount(page);const choices=await openChoices(page);
  await page.evaluate(()=>(window as any).__accountTest.defer());
  await choices.getByRole("menuitemradio",{name:"个人",exact:true}).click();
  await expect(choices).toHaveAttribute("aria-busy","true");
  for(const button of await choices.getByRole("menuitemradio").all())await expect(button).toBeDisabled();
  await expect(choices.getByRole("status")).toContainText("正在切换");
  await page.evaluate(()=>(window as any).__accountTest.finish("未保存的修改无法写入，暂不切换"));
  await expect(choices.getByRole("alert")).toHaveText("未保存的修改无法写入，暂不切换");
  await expect(choices.getByRole("menuitemradio",{name:"本地模式",exact:true})).toHaveAttribute("aria-checked","true");
  await choices.getByRole("menuitemradio",{name:"个人",exact:true}).click();
  await expect(choices).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).__accountTest.calls)).toEqual(["open","personal","未保存的修改无法写入，暂不切换","personal"]);
});
test("父切换忙态禁用子项，网页隐藏本地项并保持主菜单顺序",async({page})=>{
  await mount(page);await page.evaluate(()=>(window as any).__accountTest.patch({native:false,local:false,switchingWorkspace:true}));
  const choices=await openChoices(page);
  await expect(choices.getByRole("menuitemradio",{name:"本地模式",exact:true})).toHaveCount(0);
  for(const button of await choices.getByRole("menuitemradio").all())await expect(button).toBeDisabled();
  const labels=await page.getByRole("menu",{name:"用户菜单",exact:true}).getByRole("menuitem").allTextContents();
  expect(labels).toEqual(["工作空间切换","好友管理2","团队管理","检查更新","设置","退出登录"]);
  await page.evaluate(()=>(window as any).__accountTest.patch({switchingWorkspace:false}));
  await expect(choices.getByRole("menuitemradio",{name:"个人",exact:true})).toBeEnabled();
});
test("键盘分级导航，Escape逐级返回，外部点击关闭",async({page})=>{
  await mount(page);
  const avatar=page.getByRole("button",{name:"用户菜单",exact:true}),parent=page.getByRole("menuitem",{name:"工作空间切换",exact:true}),choices=page.getByRole("menu",{name:"工作空间切换",exact:true});
  await avatar.focus();await page.keyboard.press("ArrowDown");await expect(parent).toBeFocused();
  await page.keyboard.press("ArrowRight");await expect(choices.getByRole("menuitemradio",{name:"本地模式",exact:true})).toBeFocused();
  await page.keyboard.press("ArrowDown");await expect(choices.getByRole("menuitemradio",{name:"个人",exact:true})).toBeFocused();
  await page.keyboard.press("ArrowLeft");await expect(choices).toHaveCount(0);await expect(parent).toBeFocused();
  await page.keyboard.press("Enter");await expect(choices).toBeVisible();await page.keyboard.press("Escape");await expect(parent).toBeFocused();
  await page.keyboard.press("Escape");await expect(avatar).toBeFocused();await expect(page.getByRole("menu",{name:"用户菜单",exact:true})).toHaveCount(0);
  await openChoices(page);await page.locator("#outside").click();await expect(choices).toHaveCount(0);await expect(avatar).toHaveAttribute("aria-expanded","false");
});

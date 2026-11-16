import test from "node:test";
import assert from "node:assert/strict";
import {readWorkspaceLocation,workspaceAddress} from "../../apps/desktop/renderer/workspace-location.ts";
test("显式页面优先于桌面上次打开的笔记，合法导航状态可往返",()=>{
  for(const url of ["?page=personal","?page=teams","?page=wishes","?page=trash&type=spaces","?tab=shared","?tab=outgoing","?tab=outgoing&sharing=libraries&status=all","?tab=mine&q=中文","?team=t&view=members","?team=t&view=libraries","?space=s&folder=f&archived=1","?doc=d"]){const initial=readWorkspaceLocation(url,"old");assert.deepEqual(readWorkspaceLocation(workspaceAddress(initial).slice(1),"old"),initial);}
});
test("未知页面和页签回退首页，本地个人模式不恢复团队分享页",()=>{
  assert.equal(readWorkspaceLocation("?page=unknown").page,"home");assert.equal(readWorkspaceLocation("?tab=unknown").homeTab,"recent");assert.equal(readWorkspaceLocation("?tab=outgoing",null,true).homeTab,"recent");assert.equal(readWorkspaceLocation("","previous").selected,"previous");
});
test("个人和团队空间随链接保存，新标签页和刷新不被其他标签的偏好覆盖",()=>{
  for(const search of ["?scope=personal&page=personal","?scope=t&team=t&view=libraries","?scope=t&doc=d","?scope=t&page=notifications"]){const route=readWorkspaceLocation(search);assert.deepEqual(readWorkspaceLocation(workspaceAddress(route).slice(1)),route);}
  assert.equal(readWorkspaceLocation("?scope=team-x",null,true).scope,"");
});
test("旧笔记列表和团队分类链接归入当前空间最近，保留空间和搜索",()=>{
  for(const tab of ["mine","team"]){const route=readWorkspaceLocation(`?scope=example&tab=${tab}&q=中文`);assert.equal(route.homeTab,"recent");assert.equal(route.scope,"example");assert.equal(route.query,"中文");assert.equal(new URL(workspaceAddress(route),"http://test").searchParams.has("tab"),false);assert.equal(readWorkspaceLocation(`?tab=${tab}`,null,true).homeTab,"recent");}
});

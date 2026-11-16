import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {clientDataRoot} from "../../apps/desktop/main/client-data.mjs";
test("SimpleNote 名称升级复用旧配置，明确目录与新配置优先，原文件保持不变",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"simplenote-profile-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const current=path.join(root,"SimpleNote"),legacy=path.join(root,"ANote"),explicit=path.join(root,"explicit");
  assert.equal(clientDataRoot(root,current),current);await fs.mkdir(legacy);const content='{"directory":"/personal/notes"}\n';await fs.writeFile(path.join(legacy,"personal-mode.json"),content);assert.equal(clientDataRoot(root,current),legacy);assert.equal(clientDataRoot(root,current,explicit),explicit);assert.equal(await fs.readFile(path.join(legacy,"personal-mode.json"),"utf8"),content);
  await fs.mkdir(current);await fs.writeFile(path.join(current,"settings.json"),'{}');assert.equal(clientDataRoot(root,current),current);
});
test("ANote 名称升级复用 SimpleNote 的账号与个人目录指针",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"anote-profile-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const current=path.join(root,"ANote"),legacy=path.join(root,"SimpleNote");await fs.mkdir(legacy);
  const content='{"directory":"/personal/notes"}\n';await fs.writeFile(path.join(legacy,"personal-mode.json"),content);
  assert.equal(clientDataRoot(root,current),legacy);assert.equal(await fs.readFile(path.join(legacy,"personal-mode.json"),"utf8"),content);
  await fs.mkdir(current);await fs.writeFile(path.join(current,"settings.json"),'{}');assert.equal(clientDataRoot(root,current),current);
});
test("预览客户端不载入正式配置或旧名称账号，明确测试目录仍优先",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"anote-preview-profile-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const current=path.join(root,"ANote"),legacy=path.join(root,"SimpleNote"),explicit=path.join(root,"isolated-test");
  for(const directory of [current,legacy]){await fs.mkdir(directory);await fs.writeFile(path.join(directory,"settings.json"),'{"serverURL":"https://production.invalid"}');}
  assert.equal(clientDataRoot(root,current,undefined,{preview:true}),path.join(root,"ANote-Preview"));
  assert.equal(clientDataRoot(root,current,explicit,{preview:true}),explicit);
  assert.equal(clientDataRoot(root,current),current);
});

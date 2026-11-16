import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mobilePreviewPackages, mobilePreviewPackagesForVersion } from "../../scripts/mobile-release-catalog.mjs";
const run = promisify(execFile), installer = path.resolve("scripts/install-mobile-releases.mjs"), hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t,version="0.5.0") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anote-mobile-publish-")), source = path.join(root, "source"), clients = path.join(root, "clients"), target = path.join(clients, "mobile");
  await fs.mkdir(source); await fs.mkdir(clients); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(clients, "manifest.json"), '{"version":"0.5.1","packages":[]}\n');
  for (const item of mobilePreviewPackagesForVersion(version,version==="0.5.0")) { const bytes = Buffer.from("fixture-" + item.file); await fs.writeFile(path.join(source, item.file), bytes); await fs.writeFile(path.join(source, item.checksum), hash(bytes) + "  " + item.file + "\n"); }
  if(version!=="0.5.0") {const [a,b,c]=version.split('.').map(Number);await fs.writeFile(path.join(source,"mobile-version.json"),JSON.stringify({format:"anote-mobile-build-version",version,versionCode:a*10000+b*100+c}));}
  return { root, source, clients, target, publish: () => run(process.execPath, [installer, source, target]) };
}
test("独立发布三个原版本移动包、校验大小/SHA，重复运行不修改桌面manifest", async t => {
  const f = await fixture(t), desktopBefore = await fs.readFile(path.join(f.clients, "manifest.json")); await f.publish();
  const before = await fs.readFile(path.join(f.target, "manifest.json")), value = JSON.parse(before); assert.equal(value.packages.length, 3);
  assert.deepEqual(value.packages.map(item => item.version), ["0.5.0-preview", "0.5.0", "0.5.0"]); assert.deepEqual(value.packages.map(item => item.signing), ["test", "unsigned", "source"]);
  for (const item of value.packages) { const bytes = await fs.readFile(path.join(f.target, item.file)); assert.equal(bytes.length, item.bytes); assert.equal(hash(bytes), item.sha256); }
  await f.publish(); assert.deepEqual(await fs.readFile(path.join(f.target, "manifest.json")), before); assert.deepEqual(await fs.readFile(path.join(f.clients, "manifest.json")), desktopBefore);
  assert.equal((await fs.readdir(f.target)).some(file => file.endsWith(".partial")), false);
});
test("新构建按真实版本发布，切换移动清单保留旧包且不修改桌面更新",async t=>{
  const legacy=await fixture(t),current=await fixture(t,"0.5.2");await legacy.publish();
  const desktop=await fs.readFile(path.join(legacy.clients,"manifest.json"));
  await run(process.execPath,[installer,current.source,legacy.target]);
  const manifest=JSON.parse(await fs.readFile(path.join(legacy.target,"manifest.json"),"utf8"));
  assert.deepEqual(manifest.packages.map(item=>item.version),["0.5.2","0.5.2","0.5.2"]);
  for(const item of [...mobilePreviewPackages,...mobilePreviewPackagesForVersion("0.5.2")])assert.equal((await fs.lstat(path.join(legacy.target,item.file))).isFile(),true);
  assert.deepEqual(await fs.readFile(path.join(legacy.clients,"manifest.json")),desktop);
});
test("移动构建元信息不合法时不改当前发布，构建脚本拒绝覆盖旧产物目录",async t=>{
  const f=await fixture(t,"0.5.2");await f.publish();const before=await fs.readFile(path.join(f.target,"manifest.json"));
  for(const value of [{format:"anote-mobile-build-version",version:"../private",versionCode:502},{format:"anote-mobile-build-version",version:"0.5.2",versionCode:500}]){
    await fs.writeFile(path.join(f.source,"mobile-version.json"),JSON.stringify(value));await assert.rejects(f.publish(),/Invalid mobile build/);assert.deepEqual(await fs.readFile(path.join(f.target,"manifest.json")),before);
  }
  const old=await fixture(t);await assert.rejects(run(process.execPath,[path.resolve("scripts/sync-mobile-version.mjs"),"--prepare",old.source]),/Do not overwrite another mobile release/);
  await run(process.execPath,[path.resolve("scripts/sync-mobile-version.mjs"),"--check"]);
});
test("源摘要不匹配或已有同名内容不同时，保留原移动与桌面清单", async t => {
  const f = await fixture(t); await f.publish(); const before = await fs.readFile(path.join(f.target, "manifest.json")), desktop = await fs.readFile(path.join(f.clients, "manifest.json")), first = mobilePreviewPackages[0];
  await fs.writeFile(path.join(f.source, first.file), "changed-source"); await assert.rejects(f.publish(), /Mobile release checksum mismatch/); assert.deepEqual(await fs.readFile(path.join(f.target, "manifest.json")), before);
  await fs.writeFile(path.join(f.source, first.checksum), hash(Buffer.from("changed-source")) + "  " + first.file + "\n"); await assert.rejects(f.publish(), /Existing mobile release differs/);
  assert.deepEqual(await fs.readFile(path.join(f.target, "manifest.json")), before); assert.deepEqual(await fs.readFile(path.join(f.clients, "manifest.json")), desktop);
});
test("发布拒绝符号链接源/目标及桌面目录本身，避免覆盖正常更新源", async t => {
  const f = await fixture(t), first = mobilePreviewPackages[0];
  await assert.rejects(run(process.execPath, [installer, f.source, f.clients]), /dedicated clients\/mobile/);
  await fs.symlink(f.source, f.target); await assert.rejects(f.publish(), /cannot be a symlink/); await fs.unlink(f.target);
  const file = path.join(f.source, first.file); await fs.rename(file, path.join(f.root, "outside")); await fs.symlink(path.join(f.root, "outside"), file);
  await assert.rejects(f.publish(), /regular file/); assert.equal(await fs.stat(f.target).catch(() => null), null);
});

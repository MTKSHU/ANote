import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
const run=promisify(execFile),root=process.cwd(),hash=value=>createHash("sha256").update(value).digest("hex");
const manifest=JSON.parse(await fs.readFile("patches/y-tiptap-3.0.10-position-index.json","utf8"));
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),"anote-pinned-patch-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));for(const relative of ["scripts/apply-y-tiptap-performance-patch.mjs","patches/y-tiptap-3.0.10-position-index.json",manifest.helperFile,manifest.migrationHelperFile,"node_modules/@tiptap/y-tiptap/package.json",...manifest.files.map(item=>"node_modules/@tiptap/y-tiptap/"+item.path)]){await fs.mkdir(path.dirname(path.join(directory,relative)),{recursive:true});await fs.copyFile(path.join(root,relative),path.join(directory,relative));}return directory;}

test("pinned patch verifies ESM/CJS bytes, removes misleading source maps and is idempotent",async()=>{
  for(const item of manifest.files){const source=await fs.readFile("node_modules/@tiptap/y-tiptap/"+item.path,"utf8");assert.equal(hash(source),item.patchedSha256);assert.match(source,/createANoteMovedPositionFinder/);assert.doesNotMatch(source,/sourceMappingURL=/);}
  const checked=JSON.parse((await run(process.execPath,["scripts/apply-y-tiptap-performance-patch.mjs","--check"])).stdout);assert.deepEqual(checked.appliedFiles,[]);
  assert.deepEqual(JSON.parse((await run(process.execPath,["scripts/apply-y-tiptap-performance-patch.mjs"])).stdout).appliedFiles,[]);
  assert.equal(typeof(await import("@tiptap/y-tiptap")).ySyncPlugin,"function");
  // Loading both Yjs module formats into one process is explicitly unsafe;
  // smoke-test the CommonJS entry in its own process instead.
  await run(process.execPath,["-e",'if(typeof require("@tiptap/y-tiptap").ySyncPlugin!=="function")process.exit(1)']);
});

test("a changed upstream version, helper, or module fails closed without touching either module",async t=>{
  for(const kind of ["version","helper","module","embedded-helper","codec","embedded-codec"]){const directory=await fixture(t),target=path.join(directory,"node_modules/@tiptap/y-tiptap"),before=await Promise.all(manifest.files.map(item=>fs.readFile(path.join(target,item.path))));
    if(kind==="version"){const pkg=JSON.parse(await fs.readFile(path.join(target,"package.json"),"utf8"));pkg.version="3.0.11";await fs.writeFile(path.join(target,"package.json"),JSON.stringify(pkg));}
    if(kind==="helper")await fs.appendFile(path.join(directory,manifest.helperFile),"\n// helper tampered\n");
    if(kind==="embedded-helper"){const changed=await fs.readFile(path.join(directory,manifest.helperFile),"utf8")+"\n// reviewed helper change without regenerated module hashes\n";await fs.writeFile(path.join(directory,manifest.helperFile),changed);const spec={...manifest,helperSha256:hash(changed)};await fs.writeFile(path.join(directory,"patches/y-tiptap-3.0.10-position-index.json"),JSON.stringify(spec));}
    if(kind==="module")await fs.appendFile(path.join(target,"dist/index.cjs"),"\n// unknown patch\n");
    if(kind==='codec')await fs.appendFile(path.join(directory,manifest.migrationHelperFile),'\n// codec tampered\n');
    if(kind==='embedded-codec'){const changed=(await fs.readFile(path.join(directory,manifest.migrationHelperFile),'utf8')).replace('BLOCK=64','BLOCK=32');await fs.writeFile(path.join(directory,manifest.migrationHelperFile),changed);await fs.writeFile(path.join(directory,'patches/y-tiptap-3.0.10-position-index.json'),JSON.stringify({...manifest,migrationHelperSha256:hash(changed)}));}
    const modified=await Promise.all(manifest.files.map(item=>fs.readFile(path.join(target,item.path))));
    await assert.rejects(run(process.execPath,[path.join(directory,"scripts/apply-y-tiptap-performance-patch.mjs")]),/requires exactly|helper changed|Unexpected upstream|Embedded performance helper|Embedded migration codec/);
    for(let index=0;index<manifest.files.length;index++)assert.deepEqual(await fs.readFile(path.join(target,manifest.files[index].path)),modified[index]);
    assert.equal(before.length,2);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {localAsset} from '../../apps/desktop/main/local-assets.mjs';

test('旧Markdown原件只在当前笔记仍允许读取时作为附件回退',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'anote-legacy-asset-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'.anote'));await fs.mkdir(path.join(directory,'assets'));
  const bytes=Buffer.from('previously readable attachment');await fs.writeFile(path.join(directory,'assets','file.bin'),bytes);
  await fs.writeFile(path.join(directory,'.anote','note.base.json'),JSON.stringify({assets:[{id:'asset',path:'assets/file.bin',url:'/api/assets/asset/file',bytes:bytes.length,mime:'application/octet-stream'}]}));
  const session={settings:{user:{id:'reader'},serverURL:'https://isolated.example.test',documents:[{id:'note',directory}]}};
  const url=new URL('anote://app/api/assets/asset/file');
  assert.equal(await localAsset(new Request(url),url,session,()=>false),null);
  const allowed=await localAsset(new Request(url,{headers:{Range:'bytes=2-6'}}),url,session,id=>id==='note');
  assert.equal(allowed.status,206);assert.deepEqual(Buffer.from(await allowed.arrayBuffer()),bytes.subarray(2,7));
});

import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Mount this file alone into a candidate image. Do not mount the repository
// over /workspace: the evidence must describe the image's actual payload.
const roots=['apps/api/dist','apps/web/dist','packages/document-model/dist','packages/sync-core/dist','packages/editor/dist','node_modules/@tiptap/y-tiptap/dist/index.js','node_modules/@tiptap/y-tiptap/dist/index.cjs'];
const files=[];
async function walk(relative){
  const file=path.join('/workspace',relative),stat=await fs.lstat(file);
  if(stat.isSymbolicLink())throw new Error('Unexpected symlink in build payload');
  if(stat.isDirectory())for(const name of(await fs.readdir(file)).sort())await walk(path.posix.join(relative,name));
  else if(stat.isFile())files.push({file:relative,bytes:stat.size,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});
}
for(const root of roots)await walk(root);
const lock=await fs.readFile('/workspace/package-lock.json');
console.log(JSON.stringify({format:'anote-runtime-build-fingerprint',nodeVersion:process.version,lockSha256:createHash('sha256').update(lock).digest('hex'),files},null,2));

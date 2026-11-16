import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sameDocumentUpdate} from '../../apps/desktop/renderer/document-cache-persistence';
test('persistence deduplication requires every byte, including unaligned views and tail bytes, to match',()=>{
  const source=Uint8Array.from({length:31},(_,index)=>index);
  for(let offset=0;offset<4;offset++)for(let length=0;length<=20;length++){
    const first=source.subarray(offset,offset+length),second=new Uint8Array(first);assert.equal(sameDocumentUpdate(first,second),true);
    for(let changed=0;changed<length;changed++){const different=new Uint8Array(first);different[changed]^=1;assert.equal(sameDocumentUpdate(first,different),false);}
    assert.equal(sameDocumentUpdate(first,new Uint8Array(length+1)),false);
  }
});

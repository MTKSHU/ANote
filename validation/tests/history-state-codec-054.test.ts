import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {historyChunks,historyDigest,prepareHistoryStateInProcess,decodeHistoryChunk,MAX_HISTORY_CHUNK_BYTES} from '../../apps/api/src/history-state-codec';

test('content chunks reconstruct bytes and re-synchronize after a small insertion',()=>{
  const bytes=randomBytes(2*1024*1024),chunks=historyChunks(bytes),inserted=Buffer.concat([bytes.subarray(0,19007),Buffer.from('inserted-small-edit'),bytes.subarray(19007)]),next=historyChunks(inserted),old=new Set(chunks.map(historyDigest));
  assert(Buffer.concat(chunks).equals(bytes));assert(Buffer.concat(next).equals(inserted));assert(chunks.every(chunk=>chunk.length<=MAX_HISTORY_CHUNK_BYTES));
  assert(next.filter(chunk=>old.has(historyDigest(chunk))).reduce((sum,chunk)=>sum+chunk.length,0)>bytes.length*.8);
  assert.deepEqual(historyChunks(new Uint8Array()),[]);
});
test('prepared manifests preserve original bytes and do not depend on a mutable caller buffer',async()=>{
  const bytes=Buffer.from('位置映射原始字节\0'.repeat(15000)),original=Buffer.from(bytes),pending=prepareHistoryStateInProcess(bytes);bytes.fill(0);const prepared=await pending,objects=new Map(prepared.objects.map(chunk=>[chunk.sha256,chunk]));
  const decoded=[];for(const chunk of prepared.chunks)decoded.push(await decodeHistoryChunk(objects.get(chunk.sha256)!));
  assert(Buffer.concat(decoded).equals(original));assert.equal(prepared.sha256,historyDigest(original));assert.equal(prepared.rawBytes,original.length);
});
test('compressed corruption, declared length limits and raw checksums fail closed',async()=>{
  const prepared=await prepareHistoryStateInProcess(Buffer.from('preserve me '.repeat(3000))),object=prepared.objects[0];
  const corrupt=Uint8Array.from(object.payload);corrupt[0]^=1;await assert.rejects(decodeHistoryChunk({...object,payload:corrupt}),/校验/);
  await assert.rejects(decodeHistoryChunk({...object,sha256:'0'.repeat(64)}),/校验/);
  await assert.rejects(decodeHistoryChunk({...object,rawBytes:1}));
  const aborted=new AbortController();aborted.abort();await assert.rejects(prepareHistoryStateInProcess(Buffer.from('not written'),aborted.signal));
});
test('empty byte archives have an explicit empty manifest, without an invented Yjs document',async()=>{
  const state=await prepareHistoryStateInProcess(new Uint8Array());
  assert.equal(state.rawBytes,0);assert.equal(state.sha256,historyDigest(new Uint8Array()));
  assert.deepEqual(state.chunks,[]);assert.deepEqual(state.objects,[]);
});

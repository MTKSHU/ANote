import {createHash} from 'node:crypto';
import {deflateRaw,inflateRaw} from 'node:zlib';
import {promisify} from 'node:util';

export const MAX_HISTORY_STATE_BYTES=128*1024*1024;
export const MAX_HISTORY_CHUNK_BYTES=64*1024;
const MIN_CHUNK_BYTES=4*1024,MASK=16*1024-1;
const gear=Array.from({length:256},(_,value)=>createHash('sha256').update('anote-chunks-v1:'+value).digest().readUInt32LE());
const compress=promisify(deflateRaw),decompress=promisify(inflateRaw);
export const historyDigest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export type HistoryChunkReference={sha256:string;rawBytes:number};
export type PreparedHistoryChunk=HistoryChunkReference&{codec:'deflate-raw-v1';compressedSha256:string;payload:Uint8Array};
export type PreparedHistoryState={format:'anote-history-state-v1';sha256:string;rawBytes:number;chunks:HistoryChunkReference[];objects:PreparedHistoryChunk[]};

/** Same content anchors as desktop backup-chunks.mjs; no filesystem or backup
 * repository behavior is shared with the server's transactional object store. */
export function historyChunks(bytes:Uint8Array){
  const result:Uint8Array[]=[];let begin=0;
  while(begin<bytes.length){
    let fingerprint=0,best=0xffffffff,cut=bytes.length,chosen=0;
    for(let offset=begin;offset<Math.min(begin+MAX_HISTORY_CHUNK_BYTES,bytes.length);offset++){
      fingerprint=((fingerprint<<1)+gear[bytes[offset]])>>>0;const length=offset+1-begin;
      if(length<MIN_CHUNK_BYTES)continue;
      if(fingerprint<best){best=fingerprint;chosen=offset+1;}
      if(!(fingerprint&MASK)){cut=offset+1;break;}
      if(length===MAX_HISTORY_CHUNK_BYTES)cut=chosen;
    }
    result.push(bytes.subarray(begin,cut));begin=cut;
  }
  return result;
}
export async function prepareHistoryStateInProcess(input:Uint8Array,signal?:AbortSignal):Promise<PreparedHistoryState>{
  if(!(input instanceof Uint8Array)||input.byteLength>MAX_HISTORY_STATE_BYTES)throw new Error('历史协作状态超过存储上限');
  const bytes=Uint8Array.from(input),objects=new Map<string,PreparedHistoryChunk>(),chunks:HistoryChunkReference[]=[];
  for(const raw of historyChunks(bytes)){
    signal?.throwIfAborted();const sha256=historyDigest(raw);chunks.push({sha256,rawBytes:raw.byteLength});
    if(objects.has(sha256))continue;
    const compressed=await compress(raw,{level:6}),payload=Uint8Array.from(compressed);
    objects.set(sha256,{sha256,rawBytes:raw.byteLength,codec:'deflate-raw-v1',compressedSha256:historyDigest(payload),payload});
  }
  signal?.throwIfAborted();
  return {format:'anote-history-state-v1',sha256:historyDigest(bytes),rawBytes:bytes.byteLength,chunks,objects:[...objects.values()]};
}
export async function decodeHistoryChunk(value:PreparedHistoryChunk):Promise<Buffer>{
  if(value.codec!=='deflate-raw-v1'||!Number.isSafeInteger(value.rawBytes)||value.rawBytes<1||value.rawBytes>MAX_HISTORY_CHUNK_BYTES||historyDigest(value.payload)!==value.compressedSha256)throw new Error('历史状态分块校验失败');
  const bytes=await decompress(value.payload,{maxOutputLength:value.rawBytes});
  if(bytes.byteLength!==value.rawBytes||historyDigest(bytes)!==value.sha256)throw new Error('历史状态分块内容校验失败');
  return bytes;
}

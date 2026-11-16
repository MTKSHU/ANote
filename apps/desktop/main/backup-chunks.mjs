import {createHash} from "node:crypto";

export const MAX_BACKUP_CHUNK=64*1024;
const MIN_CHUNK=4*1024,MASK=16*1024-1;
const gear=Array.from({length:256},(_,value)=>createHash("sha256").update("anote-chunks-v1:"+value).digest().readUInt32LE());

/** Content anchors re-synchronize after insertions, without a delta chain.
 * Repeated text may never hit the mask. At the maximum search length, choose
 * its earliest minimum anchor instead of imposing a shifting fixed boundary.
 */
export function backupChunks(bytes){
  const result=[];let begin=0;
  while(begin<bytes.length){
    let fingerprint=0,best=0xffffffff,cut=bytes.length,chosen=0;
    for(let offset=begin;offset<Math.min(begin+MAX_BACKUP_CHUNK,bytes.length);offset++){
      fingerprint=((fingerprint<<1)+gear[bytes[offset]])>>>0;const length=offset+1-begin;
      if(length<MIN_CHUNK)continue;
      if(fingerprint<best){best=fingerprint;chosen=offset+1;}
      if(!(fingerprint&MASK)){cut=offset+1;break;}
      if(length===MAX_BACKUP_CHUNK)cut=chosen;
    }
    result.push(bytes.subarray(begin,cut));begin=cut;
  }
  return result;
}

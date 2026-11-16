import {parentPort,workerData} from 'node:worker_threads';
import {prepareHistoryStateInProcess} from './history-state-codec.js';
if(!parentPort)throw new Error('历史分块后台线程不可用');
try{
  const value=await prepareHistoryStateInProcess(workerData.bytes);
  parentPort.postMessage({type:'result',value},value.objects.map(chunk=>chunk.payload.buffer as ArrayBuffer));
}catch(error){parentPort.postMessage({type:'error',message:(error as Error).message});}

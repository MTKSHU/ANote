import {repairDocumentDatabase} from './document-preview-repair-core';
const worker=globalThis as unknown as {onmessage:((event:MessageEvent<{database:string}>)=>void)|null;postMessage:(value:unknown)=>void};
worker.onmessage=event=>{void repairDocumentDatabase(event.data.database).then(result=>worker.postMessage({ok:true,result})).catch(error=>worker.postMessage({ok:false,error:(error as Error).message}));};

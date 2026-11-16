import {parentPort,workerData} from 'node:worker_threads';
import * as Y from 'yjs';
import {initProseMirrorDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {resolveAnchor} from '@anote/document-model/anchors';
import {compactDocumentMigrationValues,isEncodedPositionMigration,decodePositionMigration,validateDocumentMigrationValues} from '@anote/document-model/migration-codec';
import {stable} from '@anote/sync-core';
import {createHash} from 'node:crypto';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const document=new Y.Doc({gc:true});
try{
  Y.applyUpdate(document,workerData.ystate);
  const content=()=>initProseMirrorDoc(document.getXmlFragment('default'),schema).doc.toJSON();
  const before=stable(content()),anchors=(workerData.anchors||[]).map((anchor:any)=>stable(resolveAnchor(document,anchor)));
  const sourceEncoding=validateDocumentMigrationValues(document);
  let stats:any;
  if(workerData.operation==='expand'){
    let converted=0;
    document.transact(()=>{
      for(const name of document.share.keys()){
        if(!name.startsWith('__tiptap_position_migrations:'))continue;
        const type=document.getMap(name);
        for(const [key,value] of type)if(isEncodedPositionMigration(value)){
          const decoded=decodePositionMigration(value);type.set(key,{...decoded,transfers:decoded.transfers});converted++;
        }
      }
      document.getMap('__anote_sync_meta').delete('migrationEncoding');
    });
    stats={converted,encoding:1};
  }else stats=compactDocumentMigrationValues(document);
  if(stable(content())!==before)throw new Error('整理后的正文与原稿不一致');
  for(let index=0;index<anchors.length;index++)if(stable(resolveAnchor(document,workerData.anchors[index]))!==anchors[index])throw new Error('整理后的批注锚点与原稿不一致');
  const bytes=Y.encodeStateAsUpdate(document);
  parentPort!.postMessage({ok:true,ystate:bytes,sourceEncoding,stats,hash:hash(bytes),snapshotHash:hash(before)},[bytes.buffer as ArrayBuffer]);
}catch(error){parentPort?.postMessage({ok:false,error:(error as Error).message});}
finally{document.destroy();parentPort?.close();}

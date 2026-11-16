import {parentPort,workerData} from 'node:worker_threads';
import * as Y from 'yjs';
import {initProseMirrorDoc,prosemirrorJSONToYDoc,updateYFragment} from '@tiptap/y-tiptap';
import {schema,canonical} from '@anote/document-model';
const document=workerData.ystate?new Y.Doc():prosemirrorJSONToYDoc(schema,workerData.snapshot,'default');
try{
  if(workerData.ystate){Y.applyUpdate(document,Buffer.from(workerData.ystate,'base64'));const fragment=document.getXmlFragment('default'),{meta}=initProseMirrorDoc(fragment,schema);document.transact(()=>updateYFragment(document,fragment,schema.nodeFromJSON(workerData.snapshot),meta));}
  parentPort.postMessage({snapshot:canonical(initProseMirrorDoc(document.getXmlFragment('default'),schema).doc.toJSON()),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')});
}finally{document.destroy();}

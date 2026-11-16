import type * as Y from 'yjs';
import {setDocumentMigrationEncoding} from '@anote/document-model/migration-codec';

/** Protocol bookkeeping is durable/synchronized, but is not a user edit. */
export const DOCUMENT_PROTOCOL_ORIGIN='anote:document-protocol';
export function applyDocumentMigrationEncoding(document:Y.Doc,encoding?:number){
  if(encoding!==2||document.isDestroyed)return;
  // A fresh reader must receive the server-owned marker in its first sync.
  // Manufacturing a local struct before that sync cannot be ACKed by a
  // read-only connection. Existing cached content may need one transition.
  if(!document.getXmlFragment('default').length)return;
  document.transact(()=>setDocumentMigrationEncoding(document,2),DOCUMENT_PROTOCOL_ORIGIN);
}

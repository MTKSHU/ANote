import type {PoolClient} from 'pg';
import * as Y from 'yjs';
import {compactDocumentMigrationValues,scanDocumentMigrationEncoding} from '@anote/document-model/migration-codec';
import {db} from './database.js';

export async function defaultDocumentEncoding(sql:Pick<PoolClient,'query'>=db):Promise<1|2>{
  const row=(await sql.query('SELECT default_encoding FROM document_state_settings WHERE singleton')).rows[0];
  if(row?.default_encoding!==1&&row?.default_encoding!==2)throw new Error('Missing document encoding rollout configuration');
  return row.default_encoding;
}

// Every creation path sets both the in-state marker and the database flag.
// Existing Yjs identities, including an uploaded offline draft, are preserved.
export async function initializeDocumentEncoding(document:Y.Doc,sql:Pick<PoolClient,'query'>=db):Promise<1|2>{
  const encoding=await defaultDocumentEncoding(sql);
  if(encoding===2)compactDocumentMigrationValues(document);
  else if(scanDocumentMigrationEncoding(document)>1)throw new Error('New document encoding has not been activated');
  return encoding;
}

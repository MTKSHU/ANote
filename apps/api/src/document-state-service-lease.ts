import {db} from './database.js';

// The lease covers startup guide writes through graceful Hocuspocus flushes.
// Maintenance never substitutes empty maps for a running collaboration server.
const KEY='anote:document-state-offline-maintenance:v1';
export async function acquireDocumentStateLease(mode:'service'|'maintenance'){
  const client=await db.connect(),shared=mode==='service',suffix=shared?'_shared':'';
  try{
    const row=(await client.query(`SELECT pg_try_advisory_lock${suffix}(hashtextextended($1,0)) AS acquired`,[KEY])).rows[0];
    if(!row.acquired)throw new Error(shared?'Document state maintenance is in progress; API startup refused':'An API or another maintenance process is active; offline conversion refused');
  }catch(error){client.release();throw error;}
  let released=false;
  const lost=()=>{if(!released){console.error('Document state fencing lease was lost; terminating');process.exit(1);}};
  client.on('error',lost);
  return {client,async release(){if(released)return;released=true;client.removeListener('error',lost);try{await client.query(`SELECT pg_advisory_unlock${suffix}(hashtextextended($1,0))`,[KEY]);}finally{client.release();}}};
}

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { canonical, schema, type RichDoc, type RichNode } from "@anote/document-model";
import { stable } from "@anote/sync-core";
import { db, digest, transaction } from "./database.js";
import { assetFor, localAssetPath } from "./assets.js";
import type { User } from "./auth.js";
import { platformConfig } from "./platform.js";
import { MCP_GUIDE_KEY, MCP_GUIDE_TITLE, tutorialSource } from "./onboarding-mcp-guide.js";

const templateTitle = "ANote 功能与使用示例";
function contentHash(note: any) {
  return digest(stable({title: note.title, tags: note.tags, snapshot: canonical(note.snapshot)}));
}
function guideDocument(value:RichDoc,current?:any){
  if(!current)return prosemirrorJSONToYDoc(schema,value,"default");
  const document=new Y.Doc();Y.applyUpdate(document,current.ystate);
  const fragment=document.getXmlFragment("default"),{meta}=initProseMirrorDoc(fragment,schema);
  document.transact(()=>updateYFragment(document,fragment,schema.nodeFromJSON(value),meta));
  return document;
}
async function discoverTemplate() {
  await transaction(async sql => {
    const config = (await sql.query("SELECT * FROM onboarding_template WHERE singleton FOR UPDATE")).rows[0];
    if (config.configured) return;
    const matches = (await sql.query(`SELECT d.id FROM documents d JOIN users u ON u.id=d.created_by JOIN spaces s ON s.id=d.space_id
      LEFT JOIN teams t ON t.id=s.team_id WHERE d.title=$1 AND u.is_admin AND u.active AND d.deleted_at IS NULL AND NOT d.archived
      AND s.kind='personal' AND s.created_by=d.created_by AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND COALESCE(t.archived,false)=false
      AND NOT EXISTS(SELECT 1 FROM user_onboarding o WHERE o.doc_id=d.id) ORDER BY d.created_at,d.id LIMIT 2`, [templateTitle])).rows;
    // Never guess between multiple administrators' private notes with the same title.
    if (matches.length === 1) await sql.query("UPDATE onboarding_template SET source_doc_id=$1,configured=true WHERE singleton", [matches[0].id]);
  });
}
async function template(sql: PoolClient) {
  return (await sql.query(`SELECT d.*,u.name AS author_name FROM onboarding_template o JOIN documents d ON d.id=o.source_doc_id
    JOIN users u ON u.id=d.created_by JOIN spaces s ON s.id=d.space_id LEFT JOIN teams t ON t.id=s.team_id
    WHERE o.singleton AND u.active AND u.is_admin AND d.deleted_at IS NULL AND NOT d.archived AND s.deleted_at IS NULL
    AND s.kind='personal' AND s.created_by=d.created_by AND t.deleted_at IS NULL AND COALESCE(t.archived,false)=false FOR SHARE OF d`, [])).rows[0];
}
async function discoverMcpTemplate() {
  await transaction(async sql => {
    const config=(await sql.query("SELECT * FROM onboarding_guide_templates WHERE guide_key=$1 FOR UPDATE", [MCP_GUIDE_KEY])).rows[0];
    if (config.configured) return;
    const matches=(await sql.query(`SELECT d.id FROM documents d JOIN users u ON u.id=d.created_by JOIN spaces s ON s.id=d.space_id
      WHERE d.title=$1 AND u.is_admin AND u.active AND d.deleted_at IS NULL AND NOT d.archived
      AND s.kind='personal' AND s.created_by=d.created_by AND s.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM user_onboarding_guides g WHERE g.doc_id=d.id)
      ORDER BY d.created_at,d.id LIMIT 2`, [MCP_GUIDE_TITLE])).rows;
    if (matches.length===1) await sql.query("UPDATE onboarding_guide_templates SET source_doc_id=$2,configured=true WHERE guide_key=$1", [MCP_GUIDE_KEY,matches[0].id]);
  });
}
async function mcpTemplate(sql: PoolClient) {
  return (await sql.query(`SELECT d.*,u.name AS author_name FROM onboarding_guide_templates g JOIN documents d ON d.id=g.source_doc_id
    JOIN users u ON u.id=d.created_by JOIN spaces s ON s.id=d.space_id
    WHERE g.guide_key=$1 AND u.active AND u.is_admin AND d.deleted_at IS NULL AND NOT d.archived
    AND s.kind='personal' AND s.created_by=d.created_by AND s.deleted_at IS NULL FOR SHARE OF d`, [MCP_GUIDE_KEY])).rows[0];
}
async function defaultLibrary(userId: string) {
  return transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["onboarding:" + userId]);
    if (!(await sql.query("SELECT 1 FROM users WHERE id=$1 AND active", [userId])).rowCount) return null;
    const previous = (await sql.query("SELECT * FROM user_onboarding WHERE user_id=$1", [userId])).rows[0];
    if (previous) return previous;
    let space = (await sql.query("SELECT id FROM spaces WHERE created_by=$1 AND kind='personal' AND name='默认知识库' AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1 FOR KEY SHARE", [userId])).rows[0]?.id;
    if (!space) {
      space = randomUUID();
      await sql.query("INSERT INTO spaces(id,name,created_by,kind,access_mode) VALUES($1,'默认知识库',$2,'personal','restricted')", [space,userId]);
      await sql.query("INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'admin')", [space,userId]);
    }
    await sql.query("INSERT INTO user_library_pins(user_id,space_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [userId,space]);
    return (await sql.query("INSERT INTO user_onboarding(user_id,space_id) VALUES($1,$2) RETURNING *", [userId,space])).rows[0];
  });
}
function internalLink(href: string, sourceId: string, docId: string) {
  try {
    const base = platformConfig().public_origin || "http://onboarding.local";
    const url = new URL(href,base);
    if (url.origin !== new URL(base).origin || url.pathname !== "/" || url.searchParams.get("doc") !== sourceId) return href;
    url.searchParams.set("doc",docId);
    return href.startsWith("/") ? url.pathname+url.search+url.hash : url.href;
  } catch {return href;}
}
async function copyContent(sql: PoolClient, source: any, target: {userId: string; space: string; docId: string; assetMap: Record<string,string>}) {
  const value = canonical(structuredClone(source.snapshot)), used = new Map<string,any>();
  const author = {id: source.created_by, is_admin: true, name: source.author_name} as User;
  async function asset(id: string) {
    if (used.has(id)) return used.get(id);
    const original = await assetFor(author,id,"read",sql);
    if (original.archived || original.status !== "ready") throw new Error("Onboarding attachment unavailable");
    const existingId = target.assetMap[id];
    let copied = existingId ? (await sql.query("SELECT * FROM assets WHERE id=$1 AND owner_doc_id=$2 AND created_by=$3 AND space_id=$4 AND hash=$5 AND NOT archived", [existingId,target.docId,target.userId,target.space,original.hash])).rows[0] : null;
    if (!copied) {
      const id = randomUUID();
      copied = (await sql.query(`INSERT INTO assets(id,space_id,created_by,filename,title,description,tags,mime,bytes,hash,storage_key,kind,metadata,status,owner_doc_id)
        SELECT $1,$2,$3,filename,title,description,tags,mime,bytes,hash,storage_key,kind,metadata,status,$4 FROM assets WHERE id=$5 RETURNING *`, [id,target.space,target.userId,target.docId,original.id])).rows[0];
      target.assetMap[original.id] = id;
    }
    used.set(original.id,copied);
    return copied;
  }
  async function walk(node: RichNode) {
    if (node.type === "mediaResource") {
      const a=node.attrs!,row=await asset(a.assetId);
      node.attrs={...a,assetId:row.id,src:`/api/assets/${row.id}/file`,localPath:localAssetPath(row),kind:row.kind,mime:row.mime,bytes:Number(row.bytes),hash:row.hash};
    }
    if (node.type === "imageComparison") {
      const images=[];
      for (const image of node.attrs?.images || []) {const row=await asset(image.assetId);images.push({...image,assetId:row.id,src:`/api/assets/${row.id}/file`,localPath:localAssetPath(row),hash:row.hash});}
      node.attrs={...node.attrs,images};
    }
    for (const mark of node.marks || []) if (mark.type === "link" && typeof mark.attrs?.href === "string") mark.attrs.href=internalLink(mark.attrs.href,source.id,target.docId);
    for (const child of node.content || []) await walk(child);
  }
  await walk(value);
  return {value,assets:[...used.values()]};
}
// Updating existing copies is restricted to startup, before any websocket is served.
// Login only fills missing guides: it never replaces a live editor's Y.Doc.
async function ensureFeatureGuide(userId: string, entry: any, updateExisting: boolean, discover: boolean) {
  if (entry.guide_created && !updateExisting) return "existing";
  if (discover) await discoverTemplate();
  return transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["onboarding:"+userId]);
    const own=(await sql.query("SELECT * FROM user_onboarding WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
    const space=own?.space_id && (await sql.query("SELECT * FROM spaces WHERE id=$1 AND created_by=$2 AND kind='personal' AND deleted_at IS NULL FOR KEY SHARE", [own.space_id,userId])).rows[0];
    if (!space || (own.guide_created && !own.doc_id)) return "dismissed";
    const selected=await template(sql);if(!selected)return "pending_template";
    const source=tutorialSource(selected);
    const hash=contentHash(source);
    if (own.guide_created && (!updateExisting || own.source_hash === hash)) return "existing";
    const current=own.doc_id && (await sql.query("SELECT * FROM documents WHERE id=$1 FOR UPDATE", [own.doc_id])).rows[0];
    if (own.guide_created && (!current || current.deleted_at || current.archived || current.created_by !== userId || current.space_id !== space.id)) return "dismissed";
    if (current && (contentHash(current)!==own.installed_hash || Number(current.access_revision)!==1 || (await sql.query("SELECT 1 FROM comments WHERE doc_id=$1 UNION ALL SELECT 1 FROM document_share_links WHERE doc_id=$1 UNION ALL SELECT 1 FROM document_collaborators WHERE doc_id=$1 LIMIT 1", [current.id])).rowCount)) return "customized";
    const docId=current?.id || randomUUID();
    // Assets reference the destination document, so insert an empty private shell
    // first; the whole guide, asset records, history and marker commit atomically.
    if (!current) {
      const empty=canonical({type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()}}]}),ydoc=prosemirrorJSONToYDoc(schema,empty,"default");
      try {await sql.query("INSERT INTO documents(id,space_id,title,tags,created_by,snapshot,ystate,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,'private')", [docId,space.id,source.title,source.tags,userId,empty,Buffer.from(Y.encodeStateAsUpdate(ydoc))]);} finally {ydoc.destroy();}
    }
    const target={userId,space:space.id,docId,assetMap:structuredClone(own.asset_map)};
    const copied=await copyContent(sql,source,target),document=guideDocument(copied.value,current);
    try {
      const value=initProseMirrorDoc(document.getXmlFragment("default"),schema).doc.toJSON() as RichDoc,state=Buffer.from(Y.encodeStateAsUpdate(document));
      await sql.query("UPDATE documents SET title=$2,tags=$3,snapshot=$4,ystate=$5,revision=revision+CASE WHEN $6 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1", [docId,source.title,source.tags,value,state,!!current]);
      for (const row of copied.assets) await sql.query("INSERT INTO document_assets(doc_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [docId,row.id]);
      await sql.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source,label) VALUES($1,$2,$3,$4,$5,'onboarding',$6)", [randomUUID(),docId,value,state,digest(stable(value)),current?"入门示例更新":"入门示例"]);
      await sql.query("UPDATE user_onboarding SET doc_id=$2,guide_created=true,source_hash=$3,installed_hash=$4,asset_map=$5,updated_at=now() WHERE user_id=$1", [userId,docId,hash,contentHash({title:source.title,tags:source.tags,snapshot:value}),target.assetMap]);
      await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES(NULL,$1,$2,$3)", [current?"onboarding.update":"onboarding.create",docId,{user_id:userId}]);
      return current?"updated":"created";
    } finally {document.destroy();}
  });
}
async function ensureMcpGuide(userId: string, updateExisting = false) {
  if (!updateExisting && (await db.query("SELECT 1 FROM user_onboarding_guides WHERE user_id=$1 AND guide_key=$2 AND guide_created", [userId,MCP_GUIDE_KEY])).rowCount) return "existing";
  return transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["onboarding:"+userId]);
    const space=(await sql.query(`SELECT s.id FROM user_onboarding o JOIN spaces s ON s.id=o.space_id JOIN users u ON u.id=o.user_id
      WHERE o.user_id=$1 AND u.active AND s.created_by=$1 AND s.kind='personal' AND s.deleted_at IS NULL FOR KEY SHARE OF s`, [userId])).rows[0];
    if (!space) return "dismissed";
    await sql.query("INSERT INTO user_onboarding_guides(user_id,guide_key) VALUES($1,$2) ON CONFLICT DO NOTHING", [userId,MCP_GUIDE_KEY]);
    const own=(await sql.query("SELECT * FROM user_onboarding_guides WHERE user_id=$1 AND guide_key=$2 FOR UPDATE", [userId,MCP_GUIDE_KEY])).rows[0];
    if (own.guide_created && !own.doc_id) return "dismissed";
    if (own.guide_created && !updateExisting) return "existing";
    const selected=await mcpTemplate(sql);if(!selected)return "pending_template";
    const adminSource=tutorialSource(selected),source=adminSource,hash=contentHash(source);
    const current=own.doc_id && (await sql.query("SELECT * FROM documents WHERE id=$1 FOR UPDATE", [own.doc_id])).rows[0];
    if (own.guide_created && (!current || current.deleted_at || current.archived || current.created_by!==userId || current.space_id!==space.id)) return "dismissed";
    if (current && (contentHash(current)!==own.installed_hash || Number(current.access_revision)!==1 || (await sql.query("SELECT 1 FROM comments WHERE doc_id=$1 UNION ALL SELECT 1 FROM document_share_links WHERE doc_id=$1 UNION ALL SELECT 1 FROM document_collaborators WHERE doc_id=$1 LIMIT 1", [current.id])).rowCount)) return "customized";
    if (adminSource?.created_by===userId && adminSource.space_id===space.id) {
      if (current?.id===adminSource.id) return "existing";
      // Retire only our pristine generated duplicate; the administrator's
      // existing guide, its history and permissions are never rewritten.
      if (current) await sql.query("UPDATE documents SET deleted_at=now(),trash_batch=$2 WHERE id=$1", [current.id,randomUUID()]);
      await sql.query("UPDATE user_onboarding_guides SET doc_id=$3,guide_created=true,source_hash=$4,installed_hash=$4,asset_map='{}',updated_at=now() WHERE user_id=$1 AND guide_key=$2", [userId,MCP_GUIDE_KEY,adminSource.id,hash]);
      await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES(NULL,'onboarding.adopt',$1,$2)", [adminSource.id,{user_id:userId,guide_key:MCP_GUIDE_KEY,retired_duplicate:current?.id || null}]);
      return "adopted";
    }
    if (own.guide_created && own.source_hash===hash) return "existing";
    const docId=current?.id || randomUUID();
    if (!current) {
      const empty=canonical({type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()}}]}),shell=prosemirrorJSONToYDoc(schema,empty,"default");
      try {await sql.query("INSERT INTO documents(id,space_id,title,tags,created_by,snapshot,ystate,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,'private')", [docId,space.id,source.title,source.tags,userId,empty,Buffer.from(Y.encodeStateAsUpdate(shell))]);} finally {shell.destroy();}
    }
    const target={userId,space:space.id,docId,assetMap:structuredClone(own.asset_map)};
    const copied=await copyContent(sql,adminSource,target);
    const document=guideDocument(copied.value,current);
    try {
      const value=initProseMirrorDoc(document.getXmlFragment("default"),schema).doc.toJSON() as RichDoc,state=Buffer.from(Y.encodeStateAsUpdate(document));
      await sql.query("UPDATE documents SET title=$2,tags=$3,snapshot=$4,ystate=$5,revision=revision+CASE WHEN $6 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1", [docId,source.title,source.tags,value,state,!!current]);
      for (const asset of copied.assets) await sql.query("INSERT INTO document_assets(doc_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [docId,asset.id]);
      await sql.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source,label) VALUES($1,$2,$3,$4,$5,'onboarding',$6)", [randomUUID(),docId,value,state,digest(stable(value)),current?"MCP 连接指南更新":"MCP 连接指南"]);
      await sql.query("UPDATE user_onboarding_guides SET doc_id=$3,guide_created=true,source_hash=$4,installed_hash=$5,asset_map=$6,updated_at=now() WHERE user_id=$1 AND guide_key=$2", [userId,MCP_GUIDE_KEY,docId,hash,contentHash({...source,snapshot:value}),target.assetMap]);
      await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES(NULL,$1,$2,$3)", [current?"onboarding.update":"onboarding.create",docId,{user_id:userId,guide_key:MCP_GUIDE_KEY}]);
      return current?"updated":"created";
    } finally {document.destroy();}
  });
}
export async function ensureOnboarding(userId: string, updateExisting = false, discover = true) {
  if (discover) await discoverMcpTemplate();
  const entry=await defaultLibrary(userId);
  if (!entry) return "inactive";
  // A missing feature template or attachment must not block the MCP guide.
  // The independent transaction also leaves failed feature copies retryable.
  try {return await ensureFeatureGuide(userId,entry,updateExisting,discover);}
  finally {await ensureMcpGuide(userId,updateExisting);}
}
export async function initializeOnboarding() {
  const results: Record<string,number>={};
  // Discover once per startup. Scanning the note catalog separately for every
  // existing account made large installations exceed their startup health window.
  await discoverTemplate();
  await discoverMcpTemplate();
  const hasSource=!!(await db.query("SELECT source_doc_id FROM onboarding_template WHERE singleton")).rows[0]?.source_doc_id;
  const accounts=(await db.query("SELECT id FROM users WHERE active ORDER BY created_at,id")).rows;
  for (let offset=0;offset<accounts.length;offset+=4) {
    await Promise.all(accounts.slice(offset,offset+4).map(async ({id})=>{
      try {
        let result: string;
        if (hasSource) result=await ensureOnboarding(id,true,false);
        else {
          const entry=await defaultLibrary(id);
          if (entry) await ensureMcpGuide(id,true);
          result=entry?.guide_created ? "existing" : "pending_template";
        }
        results[result]=(results[result]||0)+1;
      } catch {results.failed=(results.failed||0)+1;}
    }));
  }
  console.log("Onboarding initialization:",JSON.stringify(results));
  return results;
}
export async function onboardingOnVisit(userId: string) {
  try {await ensureOnboarding(userId);} catch {console.warn("Onboarding guide deferred; default personal library retained");}
}

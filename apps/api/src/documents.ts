import { Injectable } from "@nestjs/common";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import {
  prosemirrorJSONToYDoc,
  initProseMirrorDoc,
  updateYFragment,
} from "@tiptap/y-tiptap";
import {
  schema,
  canonical,
  EDITOR_SCHEMA_VERSION,
  type RichDoc,
} from "@anote/document-model";
import {
  exportMarkdown,
  parseMarkdown,
  mergeMarkdown,
  stable,
} from "@anote/sync-core";
import { resolveAnchor } from "@anote/document-model/anchors";
import { randomUUID } from "node:crypto";
import { db, digest, transaction } from "./database.js";
import {
  type User,
  tokenUser,
  spaceRole,
  documentRole,
  readableDocumentSQL,
} from "./auth.js";
import { fail, text, optionalText, identifier } from "./errors.js";
import type { PoolClient } from "pg";
import { localAssetPath, assetFor } from "./assets.js";
import { acquireDocument } from "./document-lock.js";
import { noteHash } from "./mcp-model.js";
import {noteMovePlan} from "./note-move.js";

const versionEditorsSQL = `COALESCE((SELECT json_agg(json_build_object('id',ids.id,'name',COALESCE(e.name,'已删除用户')) ORDER BY COALESCE(e.name,''),ids.id) FROM unnest(v.editor_ids) AS ids(id) LEFT JOIN users e ON e.id=ids.id),'[]'::json) AS editors`;

const snapshot = (document: Y.Doc) =>
  initProseMirrorDoc(
    document.getXmlFragment("default"),
    schema,
  ).doc.toJSON() as RichDoc;
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve(),
    work = previous.catch(() => {}).then(operation);
  locks.set(key, work);
  try {
    return await work;
  } finally {
    if (locks.get(key) === work) locks.delete(key);
  }
}
function replace(document: Y.Doc, value: RichDoc, actor: string) {
  const fragment = document.getXmlFragment("default"),
    { meta } = initProseMirrorDoc(fragment, schema);
  document.transact(
    () => updateYFragment(document, fragment, schema.nodeFromJSON(value), meta),
    { source: "local", context: { actor } },
  );
}
@Injectable()
export class Documents {
  server!: Server;
  private historyTimer?: ReturnType<typeof setInterval>;
  private historyTask?: Promise<void>;
  private editorClock = 0;
  private editorUpdates = new Map<string, Map<string, number>>();
  private messageLocks = new WeakMap<object,()=>void>();
  async start(handler: any) {
    this.server = new Server({
      port: Number(process.env.PORT || 3000),
      address: "0.0.0.0",
      quiet: true,
      stopOnSignals: false,
      debounce: 300,
      maxDebounce: 1500,
      async onRequest({ request, response }) {
        handler(request, response);
        return Promise.reject();
      },
      onAuthenticate: async ({ token, documentName, connectionConfig }) => {
        let credentials: { schema?: number; token?: string } = {};
        try {
          credentials = JSON.parse(token);
        } catch {}
        if (
          credentials.schema !== EDITOR_SCHEMA_VERSION ||
          typeof credentials.token !== "string"
        )
          throw Object.assign(
            new Error(
              "编辑器格式已更新，请刷新网页或安装新版桌面客户端后重新连接。",
            ),
            {
              reason:
                "编辑器格式已更新，请刷新网页或安装新版桌面客户端后重新连接。",
            },
          );
        token = credentials.token;
        const account = await tokenUser(token),
          doc = await documentRole(account, documentName),
          role = doc.role;
        connectionConfig.readOnly =
          doc.archived || !["admin", "editor"].includes(role);
        return { account, token };
      },
      beforeHandleMessage: async ({ context, documentName, connection }) => {
        const release=await acquireDocument(documentName);
        try {
        const account = await tokenUser(context.token),
          doc = await documentRole(account, documentName),
          role = doc.role;
        connection.readOnly =
          doc.archived || !["admin", "editor"].includes(role);
        this.messageLocks.set(connection,release);
        } catch(error) {release();throw error;}
      },
      onLoadDocument: async ({ documentName }) => {
        const row = (
          await db.query("SELECT ystate FROM documents WHERE id=$1", [
            documentName,
          ])
        ).rows[0];
        if (!row) throw new Error("Document not found");
        const document = new Y.Doc();
        Y.applyUpdate(document, row.ystate);
        return document;
      },
      onChange: async ({ documentName, transactionOrigin, connection }) => {
        const actor = connection?.context?.account?.id;
        if ((transactionOrigin as any)?.source !== "connection" || !actor || connection?.readOnly) return;
        const edits = this.editorUpdates.get(documentName) || new Map<string, number>();
        edits.set(actor, ++this.editorClock);
        this.editorUpdates.set(documentName, edits);
      },
      afterHandleMessage: async ({connection}) => {
        this.messageLocks.get(connection)?.();this.messageLocks.delete(connection);
      },
      onStoreDocument: async ({ documentName, document }) => {
        await this.persist(
          documentName,
          document,
          null,
          "collaboration",
        );
      },
    });
    await this.server.listen();
    this.historyTimer = setInterval(() => {
      if (!this.historyTask)
        this.historyTask = this.captureHistory()
          .catch(() =>
            console.error("Automatic note history checkpoint failed"),
          )
          .finally(() => {
            this.historyTask = undefined;
          });
    }, 5000);
    this.historyTimer.unref();
  }
  private async captureHistory() {
    const candidates = (
      await db.query(
        `SELECT d.id FROM documents d JOIN LATERAL (SELECT created_at,snapshot FROM document_versions WHERE doc_id=d.id ORDER BY created_at DESC LIMIT 1) v ON true WHERE d.snapshot IS DISTINCT FROM v.snapshot AND v.created_at<=now()-interval '60 seconds' AND NOT d.archived AND d.deleted_at IS NULL LIMIT 500`,
      )
    ).rows;
    for (const candidate of candidates)
      await locked("store:" + candidate.id, () =>
        transaction(async (client) => {
          const doc = (
            await client.query(
              "SELECT snapshot,ystate,pending_editor_ids FROM documents WHERE id=$1 FOR UPDATE",
              [candidate.id],
            )
          ).rows[0];
          if (!doc) return;
          const latest = (
            await client.query(
              "SELECT hash,created_at FROM document_versions WHERE doc_id=$1 ORDER BY created_at DESC LIMIT 1",
              [candidate.id],
            )
          ).rows[0];
          const hash = digest(stable(doc.snapshot));
          if (
            hash !== latest?.hash &&
            (!latest ||
              Date.now() - new Date(latest.created_at).getTime() >= 60000)
          ) {
            await client.query(
              "INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source,editor_ids) VALUES($1,$2,$3,$4,$5,'automatic',$6)",
              [randomUUID(), candidate.id, doc.snapshot, doc.ystate, hash, doc.pending_editor_ids],
            );
            await client.query("UPDATE documents SET pending_editor_ids='{}' WHERE id=$1", [candidate.id]);
          }
        }),
      );
  }
  disconnect(id: string) {
    for (const connection of this.server.hocuspocus.documents
      .get(id)
      ?.getConnections() || []) {
      connection.close();
      connection.webSocket.close(1012, "Document permissions changed");
    }
  }
  async checkpointLive(ids: string[], actor: string) {
    for (const id of ids) {
      const document = this.server.hocuspocus.documents.get(id);
      if (document) await this.persist(id, document, actor, "checkpoint", true);
    }
  }
  disconnectUser(userId: string) {
    for (const document of this.server.hocuspocus.documents.values())
      for (const connection of document.getConnections())
        if (connection.context?.account?.id === userId) {
          connection.close();
          connection.webSocket.close(1012, "Account permissions changed");
        }
  }
  async access<T>(
    id: string,
    fn: (document: Y.Doc) => Promise<T> | T,
  ): Promise<T> {
    const release=await acquireDocument(id);
    try {
    const connection = await this.server.hocuspocus.openDirectConnection(id, {
      source: "api",
    });
    try {
      return await fn(connection.document!);
    } finally {
      await connection.disconnect();
    }
    } finally {release();}
  }
  async persist(
    id: string,
    document: Y.Doc,
    actor: string | null,
    source: string,
    force = false,
    extra?: (client: PoolClient) => Promise<void>,
  ) {
    return locked("store:" + id, async () => {
      let captured: [string, number][] = [];
      const result = await transaction(async (client) => {
        const old = (
          await client.query(
            "SELECT snapshot,pending_editor_ids FROM documents WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!old) {
          if (source === "collaboration") {
            this.editorUpdates.delete(id);
            const value = snapshot(document);
            return {
              snapshot: value,
              hash: digest(stable(value)),
              versionId: undefined,
            };
          }
          fail(404, "文档不存在");
        }
        const value = snapshot(document),
          state = Buffer.from(Y.encodeStateAsUpdate(document)),
          hash = digest(stable(value)),
          changed = hash !== digest(stable(old.snapshot));
        captured = [...(this.editorUpdates.get(id) || [])];
        const editors = [...new Set<string>([
          ...(old.pending_editor_ids || []),
          ...(changed ? captured.map(([userId]) => userId) : []),
          // Checkpoint callers may merely flush another person's live edits.
          // Only API operations that actually replace content add their actor.
          ...(changed && actor && ["markdown", "restore"].includes(source) ? [actor] : []),
        ])];
        await client.query(
          "UPDATE documents SET ystate=$1,snapshot=$2,revision=revision+$3,updated_at=CASE WHEN $3=1 THEN now() ELSE updated_at END,pending_editor_ids=$5 WHERE id=$4",
          [state, value, changed ? 1 : 0, id, editors],
        );
        const latest = (
          await client.query(
            "SELECT id,hash,created_at FROM document_versions WHERE doc_id=$1 ORDER BY created_at DESC LIMIT 1",
            [id],
          )
        ).rows[0];
        let versionId = latest?.id;
        if (
          (!latest || latest.hash !== hash || source === "checkpoint") &&
          (force ||
            !latest ||
            Date.now() - new Date(latest.created_at).getTime() >= 60000)
        ) {
          versionId = randomUUID();
          await client.query(
            "INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,editor_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [versionId, id, value, state, hash, actor, source, editors],
          );
          await client.query("UPDATE documents SET pending_editor_ids='{}' WHERE id=$1", [id]);
        }
        if (extra) await extra(client);
        return { snapshot: value, hash, versionId };
      });
      const pending = this.editorUpdates.get(id);
      for (const [userId, revision] of captured)
        if (pending?.get(userId) === revision) pending.delete(userId);
      if (pending?.size === 0) this.editorUpdates.delete(id);
      return result;
    });
  }
  async list(account: User, space?: string, search = "", archived = false) {
    if (space) await spaceRole(account, identifier(space));
    return (
      await db.query(
        `SELECT d.id,d.space_id,d.folder_id,d.title,d.tags,d.revision,d.updated_at,d.archived,d.created_by,d.visibility,s.name AS space_name,s.kind AS space_kind,f.name AS folder_name,dc.role AS collaboration_role,u.name AS author_name,effective_document_role($1,d.id) AS role FROM documents d JOIN spaces s ON s.id=d.space_id LEFT JOIN folders f ON f.id=d.folder_id JOIN users u ON u.id=d.created_by LEFT JOIN space_members m ON m.space_id=d.space_id AND m.user_id=$1 LEFT JOIN document_collaborators dc ON dc.doc_id=d.id AND dc.user_id=$1 WHERE ${readableDocumentSQL("d")} AND ($3::text IS NULL OR d.space_id=$3) AND d.archived=$5 AND ($4='' OR d.title ILIKE '%'||$4||'%' OR d.snapshot::text ILIKE '%'||$4||'%' OR array_to_string(d.tags,' ') ILIKE '%'||$4||'%') ORDER BY d.updated_at DESC`,
        [
          account.id,
          account.is_admin,
          space || null,
          String(search).slice(0, 200),
          archived,
        ],
      )
    ).rows;
  }
  async trashList(account: User) {
    return (
      await db.query(
        "SELECT d.id,d.title,d.space_id,d.folder_id,d.deleted_at,d.trash_batch,d.deleted_at+interval '30 days' AS expires_at,d.archived,s.name AS space_name,s.kind AS space_kind,'admin' AS role FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.deleted_at IS NOT NULL AND effective_document_role_with_deleted($1,d.id)='admin' ORDER BY d.deleted_at DESC",
        [account.id],
      )
    ).rows;
  }
  async trash(account: User, id: string) {
    const doc = await documentRole(account, id, "manage", true, true);
    if (!doc.deleted_at)
      await this.access(id, (document) =>
        this.persist(id, document, account.id, "checkpoint", true),
      );
    await transaction(async (client) => {
      const current = (
        await client.query(
          "SELECT deleted_at,effective_document_role_with_deleted($2,id) AS role FROM documents WHERE id=$1 FOR UPDATE",
          [id, account.id],
        )
      ).rows[0];
      if (!current || current.role !== "admin")
        fail(403, "没有删除此笔记的权限");
      if (current.deleted_at) return;
      await client.query(
        "UPDATE documents SET deleted_at=now(),deleted_by=$2,trash_batch=$3,access_revision=access_revision+1 WHERE id=$1",
        [id, account.id, randomUUID()],
      );
      await client.query(
        "UPDATE document_share_links SET revoked_at=now() WHERE doc_id=$1 AND revoked_at IS NULL",
        [id],
      );
      await client.query(
        "INSERT INTO audit_events(actor,action,target) VALUES($1,'note.trash',$2)",
        [account.id, id],
      );
    });
    this.disconnect(id);
    return { ok: true };
  }
  async restoreDeleted(account: User, id: string) {
    await documentRole(account, id, "manage", true, true);
    await transaction(async (client) => {
      const row = (
        await client.query(
          "SELECT deleted_at,effective_document_role_with_deleted($2,id) AS role FROM documents WHERE id=$1 FOR UPDATE",
          [id, account.id],
        )
      ).rows[0];
      if (!row || row.role !== "admin")
        fail(403, "没有恢复此笔记的权限，请先恢复所属知识库及团队");
      if (!row.deleted_at) return;
      await client.query(
        "UPDATE documents SET deleted_at=NULL,deleted_by=NULL,trash_batch=NULL,access_revision=access_revision+1 WHERE id=$1",
        [id],
      );
      await client.query(
        "INSERT INTO audit_events(actor,action,target) VALUES($1,'note.restore',$2)",
        [account.id, id],
      );
    });
    return this.get(account, id);
  }
  async create(account: User, input: any) {
    const space = input?.space_id
      ? identifier(input.space_id)
      : (
          await db.query(
            "SELECT s.id FROM spaces s WHERE effective_space_role($1,s.id) IN ('admin','editor','contributor') AND $2::boolean IS NOT NULL ORDER BY (s.kind='personal') DESC,s.created_at LIMIT 1",
            [account.id, account.is_admin],
          )
        ).rows[0]?.id;
    if (!space) fail(403, "没有可编辑的知识库");
    const kind = (
      await db.query("SELECT kind FROM spaces WHERE id=$1", [space])
    ).rows[0]?.kind;
    const visibility =
      input?.visibility || (kind === "team" ? "team" : "private");
    if (!["private", "team"].includes(visibility)) fail(400, "可见性无效");
    await spaceRole(account, space, "create");
    if (
      visibility === "team" &&
      (await db.query("SELECT kind FROM spaces WHERE id=$1", [space])).rows[0]
        .kind !== "team"
    )
      fail(400, "个人知识库中的笔记请使用指定成员或外链共享");
    const title = text(input?.title || "未命名研究笔记", "文档标题"),
      folder = input?.folder_id ? identifier(input.folder_id) : null;
    if (
      folder &&
      !(
        await db.query("SELECT id FROM folders WHERE id=$1 AND space_id=$2", [
          folder,
          space,
        ])
      ).rowCount
    )
      fail(400, "目录不属于此知识库");
    const id = randomUUID(),
      value = canonical({
        type: "doc",
        content: [{ type: "paragraph", attrs: { blockId: randomUUID() } }],
      }),
      document = prosemirrorJSONToYDoc(schema, value, "default"),
      state = Buffer.from(Y.encodeStateAsUpdate(document));
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO documents(id,space_id,folder_id,title,created_by,ystate,snapshot,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, space, folder, title, account.id, state, value, visibility],
      );
      await client.query(
        "INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,editor_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          randomUUID(),
          id,
          value,
          state,
          digest(stable(value)),
          account.id,
          "create",
          [account.id],
        ],
      );
    });
    document.destroy();
    return {
      id,
      title,
      space_id: space,
      folder_id: folder,
      visibility,
      created_by: account.id,
      role: "admin",
      tags: [],
      archived: false,
    };
  }
  async get(account: User, id: string) {
    const doc = await documentRole(account, id),
      role = doc.role;
    return this.access(id, async (document) => {
      const row = (
          await db.query(
            "SELECT id,space_id,folder_id,title,tags,revision,archived,updated_at,visibility,created_by,access_revision,(SELECT count(*)::int FROM document_collaborators c WHERE c.doc_id=documents.id) AS collaborator_count,(SELECT count(*)::int FROM document_share_links l WHERE l.doc_id=documents.id AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>now())) AS external_link_count FROM documents WHERE id=$1",
            [id],
          )
        ).rows[0],
        value = snapshot(document);
      return {
        ...row,
        role,
        can_manage: role === "admin",
        ...(
          await db.query(
            "SELECT name AS space_name,kind AS space_kind FROM spaces WHERE id=$1",
            [doc.space_id],
          )
        ).rows[0],
        snapshot: value,
        hash: digest(stable(value)),
      };
    });
  }
  async metadata(account: User, id: string, input: any) {
    const release=await acquireDocument(id);
    try {await this.updateMetadata(account,id,input);} finally {release();}
    return this.get(account,id);
  }
  private async updateMetadata(account: User, id: string, input: any) {
    const doc = await documentRole(account, id, "edit", true),
      current = (await db.query("SELECT * FROM documents WHERE id=$1", [id]))
        .rows[0];
    if (input.archived !== undefined && typeof input.archived !== "boolean")
      fail(400, "归档状态无效");
    const folder =
      input.folder_id === undefined
        ? current.folder_id
        : input.folder_id
          ? identifier(input.folder_id)
          : null;
    if (
      folder &&
      !(
        await db.query("SELECT id FROM folders WHERE id=$1 AND space_id=$2", [
          folder,
          doc.space_id,
        ])
      ).rowCount
    )
      fail(400, "目录不属于此知识库");
    if (folder !== current.folder_id || (input.archived !== undefined && input.archived !== current.archived))
      await documentRole(account, id, "manage", true);
    if (folder !== current.folder_id)
      await spaceRole(account, doc.space_id, "create");
    const title =
        input.title === undefined
          ? current.title
          : text(input.title, "文档标题"),
      tags = input.tags === undefined ? current.tags : input.tags;
    if (
      !Array.isArray(tags) ||
      tags.length > 30 ||
      tags.some((tag) => typeof tag !== "string" || tag.length > 40)
    )
      fail(400, "标签格式无效");
    await db.query(
      "UPDATE documents SET title=$1,folder_id=$2,tags=$3,archived=$4,updated_at=now() WHERE id=$5",
      [
        title,
        folder,
        [...new Set(tags)],
        input.archived === undefined ? current.archived : input.archived,
        id,
      ],
    );
  }
  async commitIntegration(account:User,id:string,expectedHash:string,candidate:{snapshot:RichDoc;title:string;tags:string[]},clientName:string,extra:(sql:PoolClient,result:any)=>Promise<void>){
    return this.access(id,async document=>locked("store:"+id,async()=>{
      await documentRole(account,id,"edit");
      const clone=new Y.Doc();Y.applyUpdate(clone,Y.encodeStateAsUpdate(document));
      const before=snapshot(document),captured=[...(this.editorUpdates.get(id)||[])];
      try{
        const result=await transaction(async sql=>{
          const row=(await sql.query("SELECT * FROM documents WHERE id=$1 FOR UPDATE",[id])).rows[0];
          if(!row||row.deleted_at||row.archived)fail(409,"笔记已归档或删除，请重新读取");
          if(noteHash({...row,snapshot:before})!==expectedHash)fail(409,"笔记在预览后已更新，请重新读取并确认差异");
          const role=(await sql.query("SELECT effective_document_role($1,$2) AS role",[account.id,id])).rows[0].role;
          if(!["admin","editor"].includes(role))fail(403,"笔记编辑权限已变更");
          const beforeHash=digest(stable(before)),latest=(await sql.query("SELECT hash FROM document_versions WHERE doc_id=$1 ORDER BY created_at DESC LIMIT 1",[id])).rows[0];
          if(latest?.hash!==beforeHash)await sql.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,source,editor_ids) VALUES($1,$2,$3,$4,$5,'before-integration',$6)",[randomUUID(),id,before,Buffer.from(Y.encodeStateAsUpdate(document)),beforeHash,[...new Set([...(row.pending_editor_ids||[]),...captured.map(([actor])=>actor)])]]);
          replace(clone,candidate.snapshot,account.id);
          const value=snapshot(clone),hash=digest(stable(value)),versionId=randomUUID();
          await sql.query("UPDATE documents SET snapshot=$2,ystate=$3,title=$4,tags=$5,revision=revision+1,updated_at=now(),pending_editor_ids='{}' WHERE id=$1",[id,value,Buffer.from(Y.encodeStateAsUpdate(clone)),candidate.title,candidate.tags]);
          await sql.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,editor_ids,integration_client) VALUES($1,$2,$3,$4,$5,$6,'integration',$7,$8)",[versionId,id,value,Buffer.from(Y.encodeStateAsUpdate(clone)),hash,account.id,[account.id],clientName]);
          const result={applied:true,doc_id:id,version_id:versionId,hash,url:"/?doc="+id};await extra(sql,result);return result;
        });
        Y.applyUpdate(document,Y.encodeStateAsUpdate(clone,Y.encodeStateVector(document)),{source:"local",context:{actor:account.id}});
        const pending=this.editorUpdates.get(id);for(const [actor,revision] of captured)if(pending?.get(actor)===revision)pending.delete(actor);if(!pending?.size)this.editorUpdates.delete(id);
        return result;
      }finally{clone.destroy();}
    }));
  }
  async createIntegration(account:User,id:string,space:string,folder:string|null,candidate:{snapshot:RichDoc;title:string;tags:string[]},clientName:string,extra:(sql:PoolClient,result:any)=>Promise<void>){
    await spaceRole(account,space,"create");
    const document=prosemirrorJSONToYDoc(schema,candidate.snapshot,"default");
    try{return await transaction(async sql=>{
      await sql.query("SELECT id FROM spaces WHERE id=$1 FOR KEY SHARE",[space]);
      const role=(await sql.query("SELECT effective_space_role($1,$2) AS role",[account.id,space])).rows[0]?.role;
      if(!["admin","editor","contributor"].includes(role))fail(403,"知识库创建权限已变更");
      if(folder&&!(await sql.query("SELECT id FROM folders WHERE id=$1 AND space_id=$2 FOR KEY SHARE",[folder,space])).rowCount)fail(409,"目标目录已变化");
      const kind=(await sql.query("SELECT kind FROM spaces WHERE id=$1",[space])).rows[0]?.kind;
      const value=snapshot(document),state=Buffer.from(Y.encodeStateAsUpdate(document)),hash=digest(stable(value)),versionId=randomUUID();
      await sql.query("INSERT INTO documents(id,space_id,folder_id,title,tags,created_by,snapshot,ystate,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,space,folder,candidate.title,candidate.tags,account.id,value,state,kind==="team"?"team":"private"]);
      await sql.query("INSERT INTO document_versions(id,doc_id,snapshot,ystate,hash,author,source,editor_ids,integration_client) VALUES($1,$2,$3,$4,$5,$6,'integration',$7,$8)",[versionId,id,value,state,hash,account.id,[account.id],clientName]);
      const result={applied:true,doc_id:id,version_id:versionId,hash,url:"/?doc="+id};await extra(sql,result);return result;
    });}finally{document.destroy();}
  }
  async export(account: User, id: string) {
    const doc = await documentRole(account, id);
    return this.access(id, async (document) => {
      const value = snapshot(document),
        baseId = randomUUID(),
        hash = digest(stable(value));
      const refs = new Map<string, string>();
      const visit = (node: any) => {
        if (node.type === "mediaResource")
          refs.set(identifier(node.attrs?.assetId), node.attrs?.localPath);
        if (node.type === "imageComparison")
          for (const image of node.attrs?.images || [])
            if (image.assetId)
              refs.set(identifier(image.assetId), image.localPath);
        for (const child of node.content || []) visit(child);
      };
      visit(value);
      const assets = [];
      for (const [assetId, localPath] of refs) {
        const asset = (
          await db.query(
            "SELECT * FROM assets WHERE id=$1 AND (space_id=$2 OR (space_id IS NULL AND (owner_doc_id=$3 OR EXISTS(SELECT 1 FROM document_assets da WHERE da.asset_id=assets.id AND da.doc_id=$3))))",
            [assetId, doc.space_id, id],
          )
        ).rows[0];
        if (!asset || localPath !== localAssetPath(asset))
          fail(409, "资源引用不完整或不属于当前知识库，请在编辑器中重新插入");
        await assetFor(account, assetId);
        assets.push({
          id: asset.id,
          path: localPath,
          hash: asset.hash,
          bytes: Number(asset.bytes),
          mime: asset.mime,
          url: `/api/assets/${asset.id}/file`,
        });
      }
      await db.query(
        "INSERT INTO sync_bases(id,doc_id,actor,snapshot,hash) VALUES($1,$2,$3,$4,$5)",
        [baseId, id, account.id, value, hash],
      );
      return {
        docId: id,
        baseId,
        hash,
        markdown: exportMarkdown(id, baseId, value),
        sidecar: { format: "anote", version: 1, docId: id, baseId, hash },
        assets,
      };
    });
  }
  async import(account: User, id: string, input: any) {
    await documentRole(account, id, "edit");
    if (
      typeof input?.markdown !== "string" ||
      !/^[-\w]{10,100}$/.test(input?.opId || "")
    )
      fail(400, "缺少 Markdown 或有效操作 ID");
    return locked("import:" + id, async () => {
      const payload = digest(input.markdown),
        old = (
          await db.query(
            "SELECT * FROM sync_operations WHERE doc_id=$1 AND actor=$2 AND op_id=$3",
            [id, account.id, input.opId],
          )
        ).rows[0];
      if (old) {
        if (old.payload_hash !== payload) fail(409, "操作 ID 已用于不同内容");
        return {
          status: old.status,
          result: { ...old.result, replayed: true },
        };
      }
      let parsed;
      try {
        parsed = parseMarkdown(input.markdown);
      } catch (error) {
        fail(400, (error as Error).message);
      }
      if (parsed.docId !== id) fail(400, "Markdown 文档 ID 与目标不匹配");
      const base = (
        await db.query(
          "SELECT * FROM sync_bases WHERE id=$1 AND doc_id=$2 AND actor=$3",
          [parsed.baseId, id, account.id],
        )
      ).rows[0];
      if (!base) fail(409, "同步基准不存在或不属于此账号，请保留本地文件");
      return this.access(id, async (document) => {
        await this.persist(id, document, account.id, "before-markdown", true);
        let merged;
        try {
          merged = mergeMarkdown(
            base.snapshot,
            snapshot(document),
            input.markdown,
          );
        } catch (error) {
          fail(400, (error as Error).message);
        }
        const status = merged.conflicts.length ? 409 : 200,
          result: any = merged.conflicts.length
            ? {
                applied: false,
                conflictId: randomUUID(),
                conflicts: merged.conflicts,
                changed: [],
                actor: account.id,
              }
            : {
                applied: true,
                changed: merged.changed,
                hash: digest(stable(merged.doc)),
                actor: account.id,
              };
        const saveOperation = async (client: PoolClient) => {
          await client.query(
            "INSERT INTO sync_operations(doc_id,actor,op_id,payload_hash,status,result) VALUES($1,$2,$3,$4,$5,$6)",
            [id, account.id, input.opId, payload, status, result],
          );
        };
        if (status === 409)
          await transaction(async (client) => {
            await client.query(
              "INSERT INTO sync_conflicts(id,doc_id,actor,markdown,details) VALUES($1,$2,$3,$4,$5)",
              [
                result.conflictId,
                id,
                account.id,
                input.markdown,
                JSON.stringify(merged.conflicts),
              ],
            );
            await saveOperation(client);
          });
        else {
          replace(document, merged.doc, account.id);
          await this.persist(
            id,
            document,
            account.id,
            "markdown",
            true,
            saveOperation,
          );
        }
        return { status, result };
      });
    });
  }
  async previewMove(account:User,id:string,input:any){
    await documentRole(account,id,"manage");
    return this.access(id,async document=>{
      const row=(await db.query("SELECT * FROM documents WHERE id=$1",[id])).rows[0];
      return noteMovePlan(db,account,{...row,snapshot:snapshot(document)},input);
    });
  }
  async move(account:User,id:string,input:any,extra?:(sql:PoolClient,result:any)=>Promise<void>){
    if(typeof input.preview_hash!=="string")fail(400,"请先预览笔记移动");
    await documentRole(account,id,"manage");
    const result=await this.access(id,async document=>{
      let moved:any;
      await this.persist(id,document,account.id,"before-move",true,async sql=>{
        const row=(await sql.query("SELECT * FROM documents WHERE id=$1 FOR UPDATE",[id])).rows[0];
        await sql.query("SELECT id FROM spaces WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",[[row.space_id,identifier(input.library_id)]]);
        const plan=await noteMovePlan(sql,account,{...row,snapshot:snapshot(document)},input);
        if(plan.preview_hash!==input.preview_hash)fail(409,"笔记或目标权限在预览后发生变化，请重新预览移动");
        await sql.query("UPDATE spaces SET catalog_order=array_remove(catalog_order,$2),catalog_revision=catalog_revision+1 WHERE id=$1",[row.space_id,"note:"+id]);
        await sql.query("UPDATE documents SET space_id=$2,folder_id=$3,visibility=$4,title=$5,tags=$6,access_revision=access_revision+1,revision=revision+1,updated_at=now() WHERE id=$1",[id,plan.library_id,plan.folder_id,plan.visibility,plan.title,plan.tags]);
        await sql.query("UPDATE spaces SET catalog_order=array_append(catalog_order,$2) WHERE id=$1 AND NOT $2=ANY(catalog_order)",[plan.library_id,"note:"+id]);
        await sql.query("UPDATE assets SET space_id=$2 WHERE owner_doc_id=$1",[id,plan.library_id]);
        await sql.query("DELETE FROM document_collaborators WHERE doc_id=$1",[id]);
        await sql.query("UPDATE document_share_links SET revoked_at=now() WHERE doc_id=$1 AND revoked_at IS NULL",[id]);
        moved={applied:true,doc_id:id,library_id:plan.library_id,folder_id:plan.folder_id,visibility:plan.visibility,url:"/?doc="+id};
        if(extra)await extra(sql,moved);
        await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'note.move',$2,$3)",[account.id,id,{from_library:row.space_id,to_library:plan.library_id,folder_id:plan.folder_id,visibility:plan.visibility}]);
      });
      return moved;
    });
    this.disconnect(id);return result;
  }
  async comments(account: User, id: string, page?: {offset: number; limit: number; resolved?: boolean}) {
    await documentRole(account, id);
    return this.access(id, async (document) =>
      (
        await db.query(
          `SELECT c.*,u.name AS author_name,COALESCE(p.resolved,c.resolved) AS thread_resolved
           FROM comments c JOIN users u ON u.id=c.author LEFT JOIN comments p ON p.id=c.parent_id AND p.doc_id=c.doc_id
           WHERE c.doc_id=$1 AND ($4::boolean IS NULL OR COALESCE(p.resolved,c.resolved)=$4)
           ORDER BY c.created_at,c.id LIMIT $2 OFFSET $3`,
          [id,page?.limit ?? null,page?.offset ?? 0,page?.resolved ?? null],
        )
      ).rows.map((row) => ({
        ...row,
        resolvedAnchor: row.parent_id
          ? null
          : resolveAnchor(document, row.anchor),
      })),
    );
  }
  async comment(account: User, id: string, input: any) {
    await documentRole(account, id, "comment");
    const body = text(input?.text, "评论", 4000),
      parent = input?.parent_id ? identifier(input.parent_id) : null;
    if (parent) {
      const root = (
        await db.query(
          "SELECT id FROM comments WHERE id=$1 AND doc_id=$2 AND parent_id IS NULL",
          [parent, id],
        )
      ).rows[0];
      if (!root) fail(400, "评论线程不存在");
    }
    return this.access(id, async (document) => {
      if (!parent) {
        const anchor = resolveAnchor(document, input?.anchor);
        if (anchor.orphaned || anchor.text !== input?.anchor?.quote)
          fail(400, "评论选区已失效，请重新选择");
      }
      return (
        await db.query(
          "INSERT INTO comments(id,doc_id,parent_id,author,body,anchor) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            id,
            parent,
            account.id,
            body,
            parent ? null : input.anchor,
          ],
        )
      ).rows[0];
    });
  }
  async resolveComment(
    account: User,
    id: string,
    commentId: string,
    resolved: unknown,
  ) {
    await documentRole(account, id, "comment");
    if (typeof resolved !== "boolean") fail(400, "评论状态无效");
    const result = await db.query(
      "UPDATE comments SET resolved=$1 WHERE id=$2 AND doc_id=$3 AND parent_id IS NULL RETURNING *",
      [resolved, commentId, id],
    );
    if (!result.rowCount) fail(404, "评论线程不存在");
    return result.rows[0];
  }
  async reviews(account: User, id: string) {
    await documentRole(account, id);
    return (
      await db.query(
        "SELECT r.*,u.name AS reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer WHERE r.doc_id=$1 ORDER BY r.created_at DESC",
        [id],
      )
    ).rows;
  }
  async submit(account: User, id: string, input: any) {
    const doc = await documentRole(account, id, "edit"),
      reviewer = identifier(input?.reviewer);
    const { role } = await documentRole(
      { ...account, id: reviewer, is_admin: false },
      id,
      "review",
    );
    if (
      !role ||
      !(
        await db.query("SELECT id FROM users WHERE id=$1 AND active=true", [
          reviewer,
        ])
      ).rowCount
    )
      fail(400, "审核人无效");
    return this.access(id, async (document) => {
      const value = snapshot(document),
        hash = digest(stable(value)),
        reviewId = randomUUID();
      await this.persist(id, document, account.id, "review", true);
      await db.query(
        "INSERT INTO reviews(id,doc_id,submitter,reviewer,snapshot,hash) VALUES($1,$2,$3,$4,$5,$6)",
        [reviewId, id, account.id, reviewer, value, hash],
      );
      return { id: reviewId, status: "pending", hash };
    });
  }
  async decide(account: User, id: string, reviewId: string, input: any) {
    await documentRole(account, id, "review");
    if (!["approved", "rejected"].includes(input?.status))
      fail(400, "审核状态无效");
    const result = await db.query(
      "UPDATE reviews SET status=$1,decision=$2,decided_at=now() WHERE id=$3 AND doc_id=$4 AND reviewer=$5 AND status='pending' RETURNING *",
      [input.status, optionalText(input.comment), reviewId, id, account.id],
    );
    if (!result.rowCount) fail(409, "审核不存在、已处理或不属于当前审核人");
    return result.rows[0];
  }
  async versions(account: User, id: string) {
    await documentRole(account, id);
    return (
      await db.query(
        `SELECT v.id,v.hash,v.source,v.label,v.version_name,v.created_at,v.integration_client,v.author AS author_id,u.name AS author_name,${versionEditorsSQL} FROM document_versions v LEFT JOIN users u ON u.id=v.author WHERE v.doc_id=$1 ORDER BY v.created_at DESC`,
        [id],
      )
    ).rows;
  }
  async checkpoint(account: User, id: string, input: any) {
    await documentRole(account, id, "edit");
    const label = optionalText(input?.label, 100);
    const versionName=input?.version_name===undefined?"":text(input.version_name,"版本号",40);
    if(versionName&&!label.trim())fail(400,"请填写版本说明");
    return this.access(id, async (document) => {
      const result = await this.persist(
        id,
        document,
        account.id,
        "checkpoint",
        true,
      );
      await db.query(
        "UPDATE document_versions SET label=$1,version_name=$4 WHERE id=$2 AND doc_id=$3",
        [label, result.versionId, id,versionName],
      );
      return { id: result.versionId, hash: result.hash, label,version_name:versionName };
    });
  }
  async save(account: User, id: string) {
    await documentRole(account, id, "edit");
    return this.access(id, async document => {
      // The caller waits for its collaboration acknowledgements first. Persist
      // the shared Y.Doc without replacing concurrent edits or forcing a version.
      const result = await this.persist(id, document, null, "collaboration");
      return { ok: true, hash: result.hash };
    });
  }
  async version(account: User, id: string, versionId: string) {
    await documentRole(account, id);
    const row = (
      await db.query(
        `SELECT v.id,v.snapshot,v.hash,v.created_at,v.source,v.label,v.version_name,v.integration_client,v.author AS author_id,u.name AS author_name,${versionEditorsSQL} FROM document_versions v LEFT JOIN users u ON u.id=v.author WHERE v.id=$1 AND v.doc_id=$2`,
        [versionId, id],
      )
    ).rows[0];
    if (!row) fail(404, "版本不存在");
    return row;
  }
  async restore(account: User, id: string, versionId: string, input: any) {
    await documentRole(account, id, "edit");
    const version = await this.version(account, id, versionId);
    return locked("import:" + id, () =>
      this.access(id, async (document) => {
        if (
          typeof input?.expectedHash !== "string" ||
          input.expectedHash !== digest(stable(snapshot(document)))
        )
          fail(409, "文档已变化，请刷新后再恢复");
        await this.persist(id, document, account.id, "before-restore", true);
        if (input.expectedHash !== digest(stable(snapshot(document))))
          fail(409, "文档已变化，请刷新后再恢复");
        replace(document, version.snapshot, account.id);
        const result = await this.persist(
          id,
          document,
          account.id,
          "restore",
          true,
        );
        return { ok: true, hash: result.hash };
      }),
    );
  }
  async conflicts(account: User, id: string) {
    await documentRole(account, id);
    return (
      await db.query(
        "SELECT id,actor,details,created_at FROM sync_conflicts WHERE doc_id=$1 AND actor=$2 ORDER BY created_at DESC",
        [id, account.id],
      )
    ).rows;
  }
  async close() {
    clearInterval(this.historyTimer);
    await this.historyTask;
    await this.server?.destroy();
  }
}

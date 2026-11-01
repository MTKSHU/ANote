import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import * as Y from "yjs";
import {
  prosemirrorJSONToYDoc,
  initProseMirrorDoc,
  updateYFragment,
} from "@tiptap/y-tiptap";
import { schema, canonical } from "@anote/document-model";
import { exportMarkdown, mergeMarkdown, stable } from "@anote/sync-core";
import { moveCatalog, unwrapCatalog } from "@anote/sync-core/catalog";
import { readJSON } from "./session-store.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const uid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const title = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 240)
    fail(400, "名称为空或过长");
  return value.trim();
};
const when = () => new Date().toISOString();
export class PersonalStore {
  constructor(directory) {
    this.directory = directory;
    this.root = path.join(directory, ".anote");
    this.queue = Promise.resolve();
    this.lock = randomUUID();
  }
  async safe(relative) {
    const target = path.resolve(this.root, relative);
    if (target !== this.root && !target.startsWith(this.root + path.sep))
      fail(400, "本地路径无效");
    let current = this.directory;
    for (const part of path.relative(this.directory, target).split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      });
      if (stat?.isSymbolicLink()) fail(400, "本地笔记目录内不能使用符号链接");
    }
    return target;
  }
  async write(relative, body) {
    const file = await this.safe(relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + randomUUID() + ".tmp",
      handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        typeof body === "string" || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body, null, 2) + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.safe(relative);
    await fs.rename(temporary, file);
  }
  async load() {
    this.directory = await fs.realpath(this.directory);
    this.root = path.join(this.directory, ".anote");
    await this.safe("");
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = await this.safe("lock.json");
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token: this.lock }),
      );
      await handle.close();
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const previous = await readJSON(lockPath, {});
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
      }
      if (alive) fail(409, "此个人笔记目录已被另一客户端打开");
      await fs.unlink(lockPath);
      return this.load();
    }
    try {
      for (const folder of [
        "assets",
        "notes",
        "versions",
        "markdown",
        "uploads",
        "conflicts",
      ])
        await fs.mkdir(await this.safe(folder), {
          recursive: true,
          mode: 0o700,
        });
      this.index = await readJSON(await this.safe("catalog.json"), null);
      if (!this.index)
        this.index = {
          format: "anote-personal",
          version: 1,
          id: randomUUID(),
          theme: "auto",
          spaces: [],
          folders: [],
          documents: [],
          assets: [],
          uploads: [],
        };
      if (
        this.index.format !== "anote-personal" ||
        this.index.version !== 1 ||
        !uid(this.index.id) ||
        ![
          this.index.spaces,
          this.index.folders,
          this.index.documents,
          this.index.assets,
          this.index.uploads,
        ].every(
          (items) =>
            Array.isArray(items) && items.every((item) => uid(item.id)),
        )
      )
        fail(400, "个人笔记目录格式无效，未覆盖原文件");
      await this.write("catalog.json", this.index);
      for (const file of await fs
        .readdir(await this.safe("notes"))
        .catch((e) => {
          if (e.code === "ENOENT") return [];
          throw e;
        })) {
        const id = file.replace(/\.json$/, "");
        if (!uid(id) || this.index.documents.some((row) => row.id === id))
          continue;
        const record = await this.record(id);
        if (
          record?.metadata &&
          this.index.spaces.some(
            (space) => space.id === record.metadata.space_id,
          )
        )
          this.index.documents.push(record.metadata);
      }
      this.timer = setInterval(
        () => void this.mutate(() => this.maintenance()).catch(() => {}),
        60000,
      );
      this.timer.unref();
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  get user() {
    return {
      id: this.index.id,
      name: this.index.name || "本地个人",
      role: "admin",
      is_admin: false,
      theme: this.index.theme,
      local_password_enabled: false,
    };
  }
  state() {
    return {
      personal: true,
      desktop: true,
      serverURL: "anote://personal-" + this.index.id,
      user: this.user,
      token: null,
      offline: false,
      workspace: this.directory,
      lastDoc: this.index.lastDoc || null,
      credentialWarning: "",
      sync: { pending: [], documents: [] },
    };
  }
  mutate(fn) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const result = await fn();
        await this.write("catalog.json", this.index);
        return result;
      });
    this.queue = work;
    return work;
  }
  async close() {
    clearInterval(this.timer);
    await this.queue.catch(() => {});
    const lockFile = await this.safe("lock.json");
    if ((await readJSON(lockFile, {})).token === this.lock)
      await fs.unlink(lockFile).catch(() => {});
  }
  space(id, deleted = false) {
    const row = this.index.spaces.find(
      (item) => item.id === id && (deleted || !item.deleted_at),
    );
    if (!row) fail(404, "知识库不存在");
    return row;
  }
  note(id, deleted = false) {
    const row = this.index.documents.find(
      (item) => item.id === id && (deleted || !item.deleted_at),
    );
    if (!row) fail(404, "笔记不存在");
    this.space(row.space_id, deleted);
    return row;
  }
  metadata(row) {
    const space = this.space(row.space_id, true);
    return {
      ...row,
      role: "admin",
      can_manage: true,
      created_by: this.index.id,
      space_kind: "personal",
      space_name: space.name,
      author_name: this.user.name,
      folder_name:
        this.index.folders.find((f) => f.id === row.folder_id)?.name || null,
      visibility: "private",
      collaboration_role: null,
      collaborator_count: 0,
    };
  }
  async record(id) {
    if (!uid(id)) fail(400, "笔记 ID 无效");
    return readJSON(await this.safe("notes/" + id + ".json"), null);
  }
  async saveRecord(row, record, checkpoint = false, label,versionName="") {
    record.hash = hash(stable(record.snapshot));
    const now = Date.now();
    if (checkpoint || !record.versionAt || now - record.versionAt >= 60000) {
      if (record.versionHash !== record.hash || label !== undefined) {
        const version = {
          id: randomUUID(),
          created_at: when(),
          author_name: this.user.name,
          editors: [{ id: this.index.id, name: this.user.name }],
          source: label === undefined ? "personal" : "checkpoint",
          label: label || "",
          version_name:versionName,
          hash: record.hash,
        };
        record.versions ||= [];
        record.versions.unshift(version);
        await this.write(`versions/${row.id}/${version.id}.json`, {
          ...version,
          snapshot: record.snapshot,
          ystate: record.ystate,
        });
        record.versionHash = record.hash;
      }
      record.versionAt = now;
    }
    row.updated_at = when();
    row.revision = (row.revision || 0) + 1;
    record.metadata = { ...row };
    record.markdownBase = record.snapshot;
    record.markdownText = exportMarkdown(row.id, row.id, record.snapshot);
    await this.write("notes/" + row.id + ".json", record);
    await this.write("markdown/" + row.id + ".md", record.markdownText);
    return record;
  }
  async absorbMarkdown(row, record) {
    const filename = await this.safe("markdown/" + row.id + ".md"),
      text = await fs.readFile(filename, "utf8").catch((e) => {
        if (e.code === "ENOENT") return record.markdownText;
        throw e;
      });
    if (text === record.markdownText) return record;
    let merged;
    try {
      merged = mergeMarkdown(
        record.markdownBase || record.snapshot,
        record.snapshot,
        text,
      );
      if (merged.conflicts.length) throw new Error("增强内容存在冲突");
    } catch (error) {
      const conflict = `conflicts/${row.id}-${hash(text)}.md`;
      await this.write(conflict, text);
      record.syncWarning =
        "Markdown 修改需要人工确认，修改副本保存在 .anote/" +
        conflict +
        "；富文本原件已保留。";
      return record;
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Buffer.from(record.ystate, "base64"));
      const fragment = doc.getXmlFragment("default"),
        pm = initProseMirrorDoc(fragment, schema);
      updateYFragment(doc, fragment, schema.nodeFromJSON(merged.doc), pm.meta);
      record.snapshot = canonical(merged.doc);
      record.ystate = Buffer.from(Y.encodeStateAsUpdate(doc)).toString(
        "base64",
      );
      await this.saveRecord(row, record, true);
      return record;
    } finally {
      doc.destroy();
    }
  }
  async purge(kind, row) {
    if (kind === "spaces") {
      for (const note of [...this.index.documents].filter(
        (n) => n.space_id === row.id,
      ))
        await this.purge("documents", note);
      this.index.folders = this.index.folders.filter(
        (f) => f.space_id !== row.id,
      );
    }
    if (kind === "documents") {
      for (const asset of this.index.assets.filter((a) => a.doc_id === row.id))
        await fs.rm(await this.safe("assets/" + asset.id), { force: true });
      this.index.assets = this.index.assets.filter((a) => a.doc_id !== row.id);
      await fs.rm(await this.safe("notes/" + row.id + ".json"), {
        force: true,
      });
      await fs.rm(await this.safe("markdown/" + row.id + ".md"), {
        force: true,
      });
      await fs.rm(await this.safe("versions/" + row.id), {
        recursive: true,
        force: true,
      });
    }
    this.index[kind] = this.index[kind].filter((item) => item.id !== row.id);
  }
  async expire() {
    const expired = (row) =>
      row.deleted_at &&
      Date.now() - Date.parse(row.deleted_at) >= 30 * 86400000;
    for (const space of [...this.index.spaces].filter(expired))
      await this.purge("spaces", space);
    for (const note of [...this.index.documents].filter(expired))
      await this.purge("documents", note);
  }
  async maintenance() {
    await this.expire();
    for (const row of this.index.documents.filter((n) => !n.deleted_at)) {
      let record = await this.record(row.id);
      if (!record) continue;
      record = await this.absorbMarkdown(row, record);
      if (
        !record.syncWarning &&
        record.versionHash !== record.hash &&
        Date.now() - record.versionAt >= 60000
      )
        await this.saveRecord(row, record, true);
    }
  }
  async respond(request, url) {
    try {
      const result = await this.mutate(() => this.route(request, url));
      return result instanceof Response
        ? result
        : Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json(
        { error: error.message },
        { status: error.status || 500 },
      );
    }
  }
  async route(request, url) {
    const parts = url.pathname.slice(5).split("/"),
      [group, id, action, sub] = parts,
      method = request.method;
    const body =
      !["GET", "HEAD"].includes(method) && action !== "chunk"
        ? await request.json().catch(() => ({}))
        : {};
    if (group === "platform" && id === "public")
      return { site_name: "ANote", auth_mode: "local", public_origin: "" };
    if (group === "me") {
      if (id === "profile" && method === "PATCH") {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(body.name))
          fail(400, "昵称需为 1–80 个字符，不能包含换行或控制字符");
        this.index.name = body.name.trim();
      }
      if (id === "preferences" && method === "PATCH") {
        if (!["light", "dark", "auto"].includes(body.theme)) fail(400, "主题无效");
        this.index.theme = body.theme;
      }
      return this.user;
    }
    if (group === "teams") return [];
    if (group === "resource-limits") return { max_asset_bytes: 32 * 1024 ** 3 };
    if (group === "trash") {
      if (!["spaces", "documents", "teams"].includes(id))
        fail(404, "回收站不存在");
      if (id === "teams") return [];
      if (method === "GET")
        return this.index[id]
          .filter(
            (row) =>
              row.deleted_at &&
              (id !== "documents" ||
                !this.space(row.space_id, true).deleted_at),
          )
          .map((row) => ({
            ...row,
            ...(id === "documents" ? this.metadata(row) : {}),
            expires_at: new Date(
              Date.parse(row.deleted_at) + 30 * 86400000,
            ).toISOString(),
          }));
      const row = this.index[id].find((item) => item.id === action);
      if (!row?.deleted_at || body.deletion_token !== row.trash_batch)
        fail(409, "删除状态已变化，请刷新后重试");
      await this.purge(id, row);
      return { ok: true };
    }
    if (group === "spaces") {
      if (!id && method === "GET")
        return this.index.spaces
          .filter((row) => !row.deleted_at)
          .map((row) => ({
            ...row,
            role: "admin",
            kind: "personal",
            document_count: this.index.documents.filter(
              (d) => d.space_id === row.id && !d.deleted_at,
            ).length,
            note_count: this.index.documents.filter(d => d.space_id === row.id && !d.deleted_at && !d.archived).length,
            folder_count: this.index.folders.filter(
              (f) => f.space_id === row.id,
            ).length,
          }));
      if (!id && method === "POST") {
        if (body.kind && body.kind !== "personal")
          fail(400, "个人模式只创建个人知识库");
        const row = {
          id: randomUUID(),
          name: title(body.name),
          description: String(body.description || ""),
          kind: "personal",
          role: "admin",
          sidebar_pinned: false,
        };
        this.index.spaces.push(row);
        return row;
      }
      const row = this.space(id, action === "restore-deleted");
      if (action === "catalog") {
        const entries = [
          ...this.index.folders.filter(f => f.space_id === id).map(f => ({key:"folder:"+f.id,kind:"folder",id:f.id,parent_id:f.parent_id || null})),
          ...this.index.documents.filter(d => d.space_id === id).map(d => ({key:"note:"+d.id,kind:"note",id:d.id,parent_id:d.folder_id || null})),
        ];
        if (method === "PATCH") {
          if (String(body.revision) !== String(row.catalog_revision || 0)) fail(409,"列表已被更新，请刷新后重试");
          const key = body.kind+":"+body.id;
          try { row.catalog_order = moveCatalog(entries,row.catalog_order || [],key,body.parent_id || null,body.before || null); }
          catch (e) { fail(400,e.message); }
          if (body.kind === "folder") this.index.folders.find(f => f.id === body.id).parent_id = body.parent_id || null;
          else this.index.documents.find(d => d.id === body.id).folder_id = body.parent_id || null;
          row.catalog_revision = (row.catalog_revision || 0)+1;
        }
        const order = [...new Set([...(row.catalog_order || []),...entries.map(e => e.key)])];
        const items = entries.filter(e => e.kind === "folder" || this.index.documents.some(d => d.id === e.id && !d.deleted_at && !d.archived));
        for (const entry of items) if (entry.key === body.kind+":"+body.id && method === "PATCH") entry.parent_id = body.parent_id || null;
        return { revision: String(row.catalog_revision || 0),items: items.sort((a,b) => order.indexOf(a.key)-order.indexOf(b.key)) };
      }
      if (action === "folders") {
        if (method === "GET")
          return this.index.folders.filter((f) => f.space_id === id);
        const parent = body.parent_id || null;
        if (
          parent &&
          !this.index.folders.some((f) => f.id === parent && f.space_id === id)
        )
          fail(400, "上级目录不存在");
        if (!sub && method === "POST") {
          const folder = {
            id: randomUUID(),
            name: title(body.name),
            parent_id: parent,
            space_id: id,
          };
          this.index.folders.push(folder);
          row.catalog_revision = (row.catalog_revision || 0)+1;
          return folder;
        }
        const folder = this.index.folders.find(
          (f) => f.id === sub && f.space_id === id,
        );
        if (!folder) fail(404, "目录不存在");
        if(method === "DELETE") {
          const entries=[...this.index.folders.filter(f=>f.space_id===id).map(f=>({key:"folder:"+f.id,kind:"folder",id:f.id,parent_id:f.parent_id || null})),...this.index.documents.filter(d=>d.space_id===id).map(d=>({key:"note:"+d.id,kind:"note",id:d.id,parent_id:d.folder_id || null}))];
          const next=unwrapCatalog(entries,row.catalog_order || [],sub);
          for(const child of this.index.folders.filter(f=>f.space_id===id && f.parent_id===sub))child.parent_id=next.parent_id;
          for(const note of this.index.documents.filter(d=>d.space_id===id && d.folder_id===sub))note.folder_id=next.parent_id;
          this.index.folders=this.index.folders.filter(f=>f.id!==sub);
          row.catalog_order=next.order;row.catalog_revision=(row.catalog_revision || 0)+1;
          return {ok:true};
        }
        if (method === "PATCH") {
          folder.name = title(body.name);
          if (body.parent_id !== undefined && parent !== folder.parent_id) {
            try { row.catalog_order = moveCatalog([...this.index.folders.filter(f => f.space_id === id).map(f => ({key:"folder:"+f.id,kind:"folder",id:f.id,parent_id:f.parent_id || null})),...this.index.documents.filter(d => d.space_id === id).map(d => ({key:"note:"+d.id,kind:"note",id:d.id,parent_id:d.folder_id || null}))],row.catalog_order || [],"folder:"+folder.id,parent,null); }
            catch (e) { fail(400,e.message); }
            folder.parent_id = parent;
            row.catalog_revision = (row.catalog_revision || 0)+1;
          }
          return folder;
        }
      }
      if (action === "sidebar-pin" && method === "PATCH") {
        row.sidebar_pinned = !!body.pinned;
        row.sidebar_pinned_at = row.sidebar_pinned ? row.sidebar_pinned_at || when() : null;
        return row;
      }
      if (action === "restore-deleted") {
        const batch = row.trash_batch;
        for (const note of this.index.documents.filter(
          (n) => n.space_id === id && n.trash_batch === batch,
        )) {
          note.deleted_at = null;
          note.trash_batch = null;
        }
        row.deleted_at = null;
        row.trash_batch = null;
        return row;
      }
      if (method === "DELETE") {
        row.deleted_at = when();
        row.trash_batch = randomUUID();
        for (const note of this.index.documents.filter(
          (n) => n.space_id === id && !n.deleted_at,
        )) {
          note.deleted_at = row.deleted_at;
          note.trash_batch = row.trash_batch;
        }
        return { ok: true };
      }
      if (method === "PATCH") {
        if (body.name !== undefined) row.name = title(body.name);
        if (body.description !== undefined)
          row.description = String(body.description);
        return row;
      }
      return row;
    }
    if (group === "documents") {
      if (!id && method === "GET") {
        const query = (url.searchParams.get("q") || "").toLowerCase();
        const rows = this.index.documents
          .filter(
            (row) =>
              !row.deleted_at &&
              !this.space(row.space_id, true).deleted_at &&
              !!row.archived ===
                (url.searchParams.get("archived") === "true") &&
              (!url.searchParams.get("space_id") ||
                row.space_id === url.searchParams.get("space_id")),
          )
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map((row) => this.metadata(row));
        if (!query) return rows;
        const found = [];
        for (const row of rows) {
          if (
            row.title.toLowerCase().includes(query) ||
            (row.tags || []).join(" ").toLowerCase().includes(query) ||
            JSON.stringify((await this.record(row.id))?.snapshot || {})
              .toLowerCase()
              .includes(query)
          )
            found.push(row);
        }
        return found;
      }
      if (!id && method === "POST") {
        this.space(body.space_id);
        const row = {
          id: randomUUID(),
          space_id: body.space_id,
          folder_id: body.folder_id || null,
          title: title(body.title || "未命名笔记"),
          tags: [],
          archived: false,
          revision: 0,
          updated_at: when(),
        };
        const snapshot = canonical({
            type: "doc",
            content: [{ type: "paragraph", attrs: { blockId: randomUUID() } }],
          }),
          doc = prosemirrorJSONToYDoc(schema, snapshot, "default");
        try {
          await this.saveRecord(
            row,
            {
              snapshot,
              ystate: Buffer.from(Y.encodeStateAsUpdate(doc)).toString(
                "base64",
              ),
              versions: [],
            },
            true,
          );
        } finally {
          doc.destroy();
        }
        this.index.documents.push(row);
        const book=this.space(row.space_id);book.catalog_revision=(book.catalog_revision || 0)+1;
        return this.metadata(row);
      }
      const row = this.note(id, action === "restore-deleted");
      if (action === "restore-deleted") {
        row.deleted_at = null;
        row.trash_batch = null;
        return this.metadata(row);
      }
      if (method === "DELETE") {
        row.deleted_at = when();
        row.trash_batch = randomUUID();
        return { ok: true };
      }
      if (!action && method === "PATCH") {
        if (body.title !== undefined) row.title = title(body.title);
        if (body.tags) row.tags = body.tags;
        if (body.archived !== undefined) row.archived = !!body.archived;
        if (body.folder_id !== undefined) {
          if (
            body.folder_id &&
            !this.index.folders.some(
              (f) => f.id === body.folder_id && f.space_id === row.space_id,
            )
          )
            fail(400, "目录不属于此知识库");
          if(row.folder_id !== body.folder_id) {const book=this.space(row.space_id);book.catalog_revision=(book.catalog_revision || 0)+1;}
          row.folder_id = body.folder_id;
        }
        return this.metadata(row);
      }
      let record = await this.record(id);
      if (!record) fail(404, "笔记文件不存在");
      record = await this.absorbMarkdown(row, record);
      if (action === "local-state" && method === "PUT") {
        if (
          typeof body.ystate !== "string" ||
          body.ystate.length > 16 * 1024 ** 2
        )
          fail(400, "本地笔记内容过大或无效");
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, Buffer.from(record.ystate, "base64"));
          Y.applyUpdate(doc, Buffer.from(body.ystate, "base64"));
          record.snapshot = canonical(
            initProseMirrorDoc(
              doc.getXmlFragment("default"),
              schema,
            ).doc.toJSON(),
          );
          record.ystate = Buffer.from(Y.encodeStateAsUpdate(doc)).toString(
            "base64",
          );
          await this.saveRecord(row, record);
        } finally {
          doc.destroy();
        }
        return { ok: true, hash: record.hash };
      }
      if (action === "comments") return [];
      if (action === "versions") {
        if (!sub) {
          if (method === "POST") {
            if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 100)) fail(400, "版本说明过长或无效");
            if(body.version_name!==undefined&&(typeof body.version_name!=="string"||!body.version_name.trim()||body.version_name.length>40||!body.label?.trim()))fail(400,"请填写版本号及版本说明");
            await this.saveRecord(row, record, true, body.label || "",body.version_name?.trim()||"");
            return { id: record.versions[0].id, hash: record.hash };
          }
          return record.versions.map(version => ({ ...version, author_name: this.user.name, editors: [{ id: this.index.id, name: this.user.name }] }));
        }
        if (!uid(sub)) fail(400, "版本 ID 无效");
        const version = await readJSON(
          await this.safe(`versions/${id}/${sub}.json`),
          null,
        );
        if (!version) fail(404, "版本不存在");
        version.author_name = this.user.name;
        version.editors = [{ id: this.index.id, name: this.user.name }];
        if (parts[4] === "restore" && method === "POST") {
          if (body.expectedHash && body.expectedHash !== record.hash)
            fail(409, "正文已变化，请重试");
          await this.saveRecord(row, record, true);
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, Buffer.from(record.ystate, "base64"));
            const fragment = doc.getXmlFragment("default"),
              pm = initProseMirrorDoc(fragment, schema);
            updateYFragment(
              doc,
              fragment,
              schema.nodeFromJSON(version.snapshot),
              pm.meta,
            );
            record.snapshot = version.snapshot;
            record.ystate = Buffer.from(Y.encodeStateAsUpdate(doc)).toString(
              "base64",
            );
            await this.saveRecord(row, record, true);
          } finally {
            doc.destroy();
          }
          return { ok: true };
        }
        return version;
      }
      if (action === "assets") {
        const values = this.index.assets.filter((a) => a.doc_id === id);
        return values.map((a) => this.asset(a));
      }
      if (action === "export")
        return {
          markdown: record.markdownText,
          snapshot: record.snapshot,
          hash: record.hash,
          assets: this.index.assets
            .filter((a) => a.doc_id === id)
            .map((a) => this.asset(a)),
        };
      return {
        ...this.metadata(row),
        snapshot: record.snapshot,
        ystate: record.ystate,
        hash: record.hash,
        sync_warning: record.syncWarning || "",
      };
    }
    if (group === "uploads") {
      if (!id && method === "POST") {
        this.note(body.doc_id);
        if (
          !/^[a-f0-9]{64}$/.test(body.hash) ||
          !Number.isSafeInteger(body.bytes) ||
          body.bytes < 1 ||
          body.bytes > 32 * 1024 ** 3
        )
          fail(400, "文件大小或校验值无效");
        let task = this.index.uploads.find(
          (t) =>
            t.doc_id === body.doc_id &&
            t.hash === body.hash &&
            t.bytes === body.bytes,
        );
        if (!task) {
          task = {
            id: randomUUID(),
            doc_id: body.doc_id,
            filename: title(body.filename),
            hash: body.hash,
            bytes: body.bytes,
            offset: 0,
            chunk_bytes: 4 * 1024 ** 2,
          };
          this.index.uploads.push(task);
          await this.write("uploads/" + task.id, Buffer.alloc(0));
        }
        return task;
      }
      const task = this.index.uploads.find((t) => t.id === id);
      if (!task) fail(404, "上传任务不存在");
      this.note(task.doc_id);
      const file = await this.safe("uploads/" + task.id);
      if (action === "chunk") {
        const offset = Number(request.headers.get("upload-offset")),
          chunks = [];
        let bytes = 0;
        if (offset !== task.offset) fail(409, "上传位置已变化");
        for await (const value of request.body) {
          const chunk = Buffer.from(value);
          bytes += chunk.length;
          if (bytes > task.chunk_bytes || offset + bytes > task.bytes)
            fail(413, "上传分块过大");
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        if (hash(data) !== request.headers.get("x-chunk-sha256"))
          fail(422, "分块校验失败");
        const handle = await fs.open(file, "r+");
        try {
          await handle.write(data, 0, data.length, offset);
          await handle.sync();
        } finally {
          await handle.close();
        }
        task.offset += bytes;
        return task;
      }
      if (action === "complete") {
        if (task.offset !== task.bytes) fail(409, "文件未上传完成");
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(file)) digest.update(chunk);
        if (digest.digest("hex") !== task.hash) fail(422, "文件校验失败");
        const header = Buffer.alloc(Math.min(task.bytes, 65536)),
          handle = await fs.open(file, "r");
        try {
          await handle.read(header, 0, header.length, 0);
        } finally {
          await handle.close();
        }
        const asset = {
          id: randomUUID(),
          doc_id: task.doc_id,
          filename: task.filename,
          title: task.filename,
          bytes: task.bytes,
          hash: task.hash,
          ...identify(header, task.filename),
        };
        await fs.rename(file, await this.safe("assets/" + asset.id));
        this.index.assets.push(asset);
        this.index.uploads = this.index.uploads.filter((t) => t.id !== id);
        return this.asset(asset);
      }
    }
    if (group === "assets") {
      const asset = this.index.assets.find((a) => a.id === id);
      if (!asset) fail(404, "附件不存在");
      this.note(asset.doc_id);
      if (action === "file") return this.file(request, url, asset);
      if (method === "PATCH") {
        if (body.title !== undefined) asset.title = title(body.title);
        asset.tags = body.tags || asset.tags || [];
        asset.description = String(body.description || "");
      }
      return this.asset(asset);
    }
    fail(404, "个人模式不提供此团队功能");
  }
  asset(row) {
    return {
      ...row,
      revision: 1,
      tags: row.tags || [],
      description: row.description || "",
      can_edit: true,
      url: "/api/assets/" + row.id + "/file",
      localPath: "../assets/" + row.id,
      status: "ready",
    };
  }
  async file(request, url, asset) {
    const file = await this.safe("assets/" + asset.id),
      size = (await fs.stat(file)).size;
    let start = 0,
      end = size - 1,
      status = 200;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (start > end || start >= size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      status = 206;
    }
    return new Response(
      request.method === "HEAD"
        ? null
        : Readable.toWeb(createReadStream(file, { start, end })),
      {
        status,
        headers: {
          "Content-Type": asset.mime,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
          ...(status === 206
            ? { "Content-Range": `bytes ${start}-${end}/${size}` }
            : {}),
          "Content-Disposition":
            (url.searchParams.get("download") === "1"
              ? "attachment"
              : "inline") +
            "; filename*=UTF-8''" +
            encodeURIComponent(asset.filename),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      },
    );
  }
}
function identify(header, filename) {
  const prefix = header.toString("utf8"),
    ext = path.extname(filename).toLowerCase();
  let kind = "file",
    mime = "application/octet-stream",
    metadata = {};
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    kind = "image";
    mime = "image/png";
  } else if (header[0] === 255 && header[1] === 216) {
    kind = "image";
    mime = "image/jpeg";
  } else if (/^GIF8/.test(prefix)) {
    kind = "image";
    mime = "image/gif";
  } else if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
    kind = "image";
    mime = "image/webp";
  } else if (prefix.slice(4, 8) === "ftyp") {
    kind = ext === ".m4a" ? "audio" : "video";
    mime = kind === "audio" ? "audio/mp4" : "video/mp4";
  } else if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) {
    kind = "video";
    mime = "video/webm";
  } else if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WAVE") {
    kind = "audio";
    mime = "audio/wav";
  } else if (
    prefix.startsWith("ID3") ||
    (header[0] === 255 && (header[1] & 224) === 224)
  ) {
    kind = "audio";
    mime = "audio/mpeg";
  } else if (prefix.startsWith("OggS") || prefix.startsWith("fLaC")) {
    kind = "audio";
    mime = prefix.startsWith("OggS") ? "audio/ogg" : "audio/flac";
  } else if (prefix.startsWith("%PDF-")) mime = "application/pdf";
  else if ([".glb", ".obj", ".ply", ".splat"].includes(ext)) {
    kind =
      ext === ".splat" || (ext === ".ply" && prefix.includes(" f_dc_0"))
        ? "gaussian"
        : ext === ".ply" && !/element face [1-9]/.test(prefix)
          ? "pointcloud"
          : "mesh";
    metadata.format = ext.slice(1);
  } else if (
    [
      ".blend",
      ".unity",
      ".unitypackage",
      ".uproject",
      ".uasset",
      ".umap",
      ".zip",
      ".7z",
      ".tar",
      ".gz",
      ".gltf",
    ].includes(ext)
  )
    kind = "project";
  return { kind, mime, metadata };
}

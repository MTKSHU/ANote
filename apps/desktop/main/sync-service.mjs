import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createWorkspaceSync } from "@anote/sync-core/workspace";
import { atomicJSON, readJSON } from "./session-store.mjs";

export class SyncService {
  constructor(session, onState) {
    this.session = session;
    this.onState = onState;
    this.jobs = new Map();
    this.watchers = new Map();
    this.timers = new Map();
    this.running = false;
    this.results = new Map();
    this.closed = false;
    this.saves = Promise.resolve();
    this.queueFile = path.join(session.profileRoot, "sync-queue.json");
  }
  async load() {
    for (const job of await readJSON(this.queueFile, [])) {
      this.jobs.set(job.docId, job);
      if (job.error)
        this.results.set(job.docId, {
          error: job.error,
          conflicts: job.conflicts || [],
        });
    }
    for (const doc of this.session.settings.documents) this.watch(doc);
    this.timer = setInterval(() => {
      for (const doc of this.session.settings.documents)
        if (!this.jobs.get(doc.id)?.blocked)
          void this.schedule(doc.id).catch((error) => {
            this.results.set(doc.id, { error: error.message });
            this.onState();
          });
    }, 5000);
    this.timer.unref();
    return this;
  }
  async persist() {
    const jobs = structuredClone([...this.jobs.values()]);
    this.saves = this.saves
      .catch(() => {})
      .then(() => atomicJSON(this.queueFile, jobs));
    await this.saves;
    this.onState();
  }
  status() {
    return {
      running: this.running,
      pending: [...this.jobs.values()].map(({ docId, error, blocked }) => ({
        docId,
        error,
        blocked: !!blocked,
      })),
      documents: this.session.settings.documents.map((doc) => ({
        ...doc,
        result: this.results.get(doc.id) || null,
      })),
    };
  }
  client(doc, operationId) {
    if (!this.session.token) throw new Error("请先登录后同步");
    return createWorkspaceSync({
      serverURL: this.session.settings.serverURL,
      id: doc.id,
      directory: doc.directory,
      token: this.session.token,
      operationId,
    });
  }
  async checkout(id, title) {
    if (!/^[\w-]{1,80}$/.test(id)) throw new Error("文档 ID 无效");
    if (!this.session.settings.workspace)
      throw new Error("请先选择本地工作目录");
    if (this.session.settings.offline)
      throw new Error("首次下载文档需要连接服务器");
    let doc = this.session.settings.documents.find((d) => d.id === id);
    if (!doc) {
      doc = {
        id,
        title,
        directory: path.join(this.session.settings.workspace, id),
      };
      await fs.mkdir(doc.directory, { recursive: true });
      await this.client(doc).pull();
      this.session.settings.documents.push(doc);
      await this.session.save();
      this.watch(doc);
    }
    await this.schedule(id, true);
    return doc;
  }
  watch(doc) {
    if (this.watchers.has(doc.id)) return;
    try {
      this.watchers.set(
        doc.id,
        watch(doc.directory, { persistent: false }, (_event, file) => {
          if (file?.toString().endsWith(".md")) {
            clearTimeout(this.timers.get(doc.id));
            this.timers.set(
              doc.id,
              setTimeout(
                () =>
                  void this.schedule(doc.id, true).catch((error) => {
                    this.results.set(doc.id, { error: error.message });
                    this.onState();
                  }),
                450,
              ),
            );
          }
        }),
      );
    } catch (error) {
      this.results.set(doc.id, { error: error.message });
    }
  }
  async schedule(id, manual = false) {
    if (this.closed) return this.status();
    if (manual && this.jobs.get(id)) this.jobs.get(id).blocked = false;
    if (!this.jobs.has(id))
      this.jobs.set(id, {
        docId: id,
        opId: randomUUID(),
        createdAt: new Date().toISOString(),
        error: "",
      });
    await this.persist();
    await this.drain();
    return this.status();
  }
  drain() {
    if (
      this.running ||
      this.closed ||
      this.session.settings.offline ||
      !this.session.token
    )
      return this.draining || Promise.resolve();
    this.draining = this.run();
    return this.draining;
  }
  async run() {
    this.running = true;
    this.onState();
    try {
      for (const [id, job] of this.jobs) {
        if (this.closed || this.session.settings.offline) break;
        if (job.blocked) continue;
        const doc = this.session.settings.documents.find((d) => d.id === id);
        if (!doc) {
          this.jobs.delete(id);
          continue;
        }
        try {
          const result = await this.client(doc, async (markdown) => {
            const hash = createHash("sha256").update(markdown).digest("hex");
            if (job.hash !== hash) {
              job.hash = hash;
              job.opId = randomUUID();
            }
            await this.persist();
            return job.opId;
          }).sync();
          this.results.set(id, { ...result, at: new Date().toISOString() });
          this.jobs.delete(id);
        } catch (error) {
          job.error = error.message;
          job.blocked = error.status === 409;
          job.conflicts = error.data?.conflicts || [];
          this.results.set(id, {
            error: error.message,
            conflicts: error.data?.conflicts || [],
            at: new Date().toISOString(),
          });
        }
        await this.persist();
      }
    } finally {
      this.running = false;
      this.onState();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const watcher of this.watchers.values()) watcher.close();
    await this.draining;
    await this.persist();
  }
  async acceptRemote(id) {
    await this.draining;
    if (this.closed || this.session.settings.offline)
      throw new Error("请先恢复连接");
    const doc = this.session.settings.documents.find((d) => d.id === id);
    if (!doc || !this.jobs.get(id)?.blocked) throw new Error("没有待处理冲突");
    const result = await this.client(doc).acceptRemote();
    this.jobs.delete(id);
    this.results.set(id, { ...result, at: new Date().toISOString() });
    await this.persist();
    return result;
  }
}

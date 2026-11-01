import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Module,
  Injectable,
  Inject,
  HttpException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Server } from "@hocuspocus/server";
import { Pool } from "pg";
import * as Y from "yjs";
import {
  prosemirrorJSONToYDoc,
  initProseMirrorDoc,
  updateYFragment,
} from "@tiptap/y-tiptap";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { schema, fixture, type RichDoc } from "../shared/model.js";
import {
  exportMarkdown,
  parseMarkdown,
  mergeMarkdown,
  stable,
} from "../shared/merge.js";
import { resolveAnchor } from "../shared/anchors.js";
import { assets } from "../shared/assets.js";

type User = {
  id: string;
  name: string;
  role: "editor" | "reviewer" | "viewer" | "outsider";
};
const users: Record<string, User> = {
  alice: { id: "alice", name: "林一", role: "editor" },
  bob: { id: "bob", name: "周可", role: "editor" },
  carol: { id: "carol", name: "陈默", role: "reviewer" },
  viewer: { id: "viewer", name: "只读成员", role: "viewer" },
  outsider: { id: "outsider", name: "未授权成员", role: "outsider" },
};
const secret = process.env.VALIDATION_SECRET;
if (!secret || secret.length < 24)
  throw new Error("VALIDATION_SECRET must contain at least 24 characters");
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const hash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const deny = (status: number, message: string): never => {
  throw new HttpException({ error: message }, status);
};
const same = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
const tokenFor = (id: string) =>
  `${id}.${createHmac("sha256", secret)
    .update("validation:" + id)
    .digest("base64url")}`;
function tokenUser(token: string): User {
  const [id] = token.split(".");
  const user = users[id];
  if (!user || !same(tokenFor(id), token)) return deny(401, "登录凭据无效");
  return user;
}
function member(user: User, edit = false) {
  if (user.role === "outsider") deny(403, "无此验证空间权限");
  if (edit && user.role !== "editor") deny(403, "当前成员没有正文编辑权限");
}
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) || Promise.resolve();
  const work = prev.catch(() => {}).then(fn);
  locks.set(id, work);
  try {
    return await work;
  } finally {
    if (locks.get(id) === work) locks.delete(id);
  }
}
let server: Server;
function docJSON(doc: Y.Doc): RichDoc {
  return initProseMirrorDoc(
    doc.getXmlFragment("default"),
    schema,
  ).doc.toJSON() as RichDoc;
}
async function access<T>(
  id: string,
  fn: (doc: Y.Doc) => T | Promise<T>,
): Promise<T> {
  const conn = await server.hocuspocus.openDirectConnection(id, {
    source: "api",
  });
  try {
    return await fn(conn.document!);
  } finally {
    await conn.disconnect();
  }
}
async function ensure(id: string) {
  if (!/^[\w-]{1,80}$/.test(id)) deny(400, "文档 ID 无效");
  const row = (await db.query("SELECT id FROM documents WHERE id=$1", [id]))
    .rows[0];
  if (!row) deny(404, "文档不存在");
}

@Injectable()
class LabService {
  user(req: Request, edit = false) {
    const u = tokenUser(
      (req.headers.authorization || "").replace(/^Bearer /, ""),
    );
    member(u, edit);
    return u;
  }
  async create(user: User, title = "协同验证文档") {
    member(user, true);
    const id = randomUUID(),
      doc = prosemirrorJSONToYDoc(schema, fixture(), "default");
    await db.query(
      "INSERT INTO documents(id,title,ystate,snapshot) VALUES($1,$2,$3,$4)",
      [
        id,
        String(title).slice(0, 200),
        Buffer.from(Y.encodeStateAsUpdate(doc)),
        fixture(),
      ],
    );
    doc.destroy();
    return { id, title };
  }
  async get(id: string) {
    await ensure(id);
    return access(id, async (doc) => {
      const row = (
        await db.query("SELECT title,revision FROM documents WHERE id=$1", [id])
      ).rows[0];
      return {
        id,
        ...row,
        snapshot: docJSON(doc),
        stateVector: hash(Y.encodeStateVector(doc)),
      };
    });
  }
  async export(id: string) {
    await ensure(id);
    return access(id, async (doc) => {
      const snapshot = docJSON(doc),
        baseId = randomUUID(),
        digest = hash(stable(snapshot));
      await db.query(
        "INSERT INTO sync_bases(id,doc_id,snapshot,hash) VALUES($1,$2,$3,$4)",
        [baseId, id, snapshot, digest],
      );
      return {
        docId: id,
        baseId,
        hash: digest,
        markdown: exportMarkdown(id, baseId, snapshot),
        sidecar: {
          format: "anote-validation",
          version: 1,
          docId: id,
          baseId,
          hash: digest,
        },
        assets: Object.entries(assets).map(([id, svg]) => ({
          id,
          path: `assets/${id}.svg`,
          url: `/fixtures/${id}.svg`,
          hash: hash(svg),
        })),
      };
    });
  }
  async import(id: string, user: User, input: any) {
    member(user, true);
    await ensure(id);
    if (
      typeof input?.markdown !== "string" ||
      !/^[-\w]{10,100}$/.test(input.opId || "")
    )
      deny(400, "缺少 Markdown 或有效操作 ID");
    return locked(id, async () => {
      const payloadHash = hash(input.markdown),
        old = (
          await db.query(
            "SELECT * FROM sync_operations WHERE doc_id=$1 AND op_id=$2",
            [id, input.opId],
          )
        ).rows[0];
      if (old) {
        if (old.payload_hash !== payloadHash)
          deny(409, "操作 ID 已用于不同内容");
        return {
          status: old.status,
          result: { ...old.result, replayed: true },
        };
      }
      let parsed;
      try {
        parsed = parseMarkdown(input.markdown);
      } catch (e) {
        return deny(400, (e as Error).message);
      }
      if (parsed.docId !== id) deny(400, "Markdown 文档 ID 与目标不匹配");
      const base = (
        await db.query("SELECT * FROM sync_bases WHERE id=$1 AND doc_id=$2", [
          parsed.baseId,
          id,
        ])
      ).rows[0];
      if (!base) deny(409, "同步基准不存在，保留本地文件并重新获取基准");
      return access(id, async (doc) => {
        let merged;
        try {
          merged = mergeMarkdown(base.snapshot, docJSON(doc), input.markdown);
        } catch (e) {
          return deny(400, (e as Error).message);
        }
        let status = 200,
          result: any;
        if (merged.conflicts.length) {
          status = 409;
          const conflictId = randomUUID();
          await db.query(
            "INSERT INTO sync_conflicts(id,doc_id,actor,markdown,details) VALUES($1,$2,$3,$4,$5)",
            [
              conflictId,
              id,
              user.id,
              input.markdown,
              JSON.stringify(merged.conflicts),
            ],
          );
          result = {
            applied: false,
            conflictId,
            conflicts: merged.conflicts,
            changed: [],
            actor: user.id,
          };
        } else {
          const fragment = doc.getXmlFragment("default"),
            { meta } = initProseMirrorDoc(fragment, schema);
          doc.transact(
            () =>
              updateYFragment(
                doc,
                fragment,
                schema.nodeFromJSON(merged.doc),
                meta,
              ),
            {
              source: "local",
              context: { actor: user.id, source: "markdown" },
            },
          );
          result = {
            applied: true,
            changed: merged.changed,
            hash: hash(stable(docJSON(doc))),
            actor: user.id,
          };
        }
        await db.query(
          "INSERT INTO sync_operations(doc_id,op_id,payload_hash,status,result) VALUES($1,$2,$3,$4,$5)",
          [id, input.opId, payloadHash, status, result],
        );
        return { status, result };
      });
    });
  }
  async comments(id: string) {
    await ensure(id);
    return access(id, async (doc) =>
      (
        await db.query(
          "SELECT * FROM comments WHERE doc_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows.map((c) => ({
        ...c,
        resolvedAnchor: resolveAnchor(doc, c.anchor),
      })),
    );
  }
}

@Controller("api")
class LabController {
  constructor(@Inject(LabService) private readonly lab: LabService) {}
  @Get("health") health() {
    return { ok: true, mode: "validation-only" };
  }
  @Post("session") session(@Body() input: any) {
    if (!same(String(input?.secret || ""), secret!))
      deny(401, "验证口令不正确");
    const user = users[input.user];
    if (!user) deny(400, "未知验证账号");
    return { token: tokenFor(user.id), user };
  }
  @Get("me") me(@Req() req: Request) {
    return this.lab.user(req);
  }
  @Get("documents") async documents(@Req() req: Request) {
    this.lab.user(req);
    return (
      await db.query(
        "SELECT id,title,revision,updated_at FROM documents ORDER BY updated_at DESC",
      )
    ).rows;
  }
  @Post("documents") create(@Req() req: Request, @Body() input: any) {
    return this.lab.create(this.lab.user(req, true), input?.title);
  }
  @Get("documents/:id") get(@Req() req: Request, @Param("id") id: string) {
    this.lab.user(req);
    return this.lab.get(id);
  }
  @Get("documents/:id/export") export(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    this.lab.user(req);
    return this.lab.export(id);
  }
  @Post("documents/:id/import") async import(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
    @Res() res: Response,
  ) {
    const result = await this.lab.import(id, this.lab.user(req, true), input);
    res.status(result.status).json(result.result);
  }
  @Get("documents/:id/conflicts") async conflicts(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    this.lab.user(req);
    await ensure(id);
    return (
      await db.query(
        "SELECT id,actor,details,created_at FROM sync_conflicts WHERE doc_id=$1 ORDER BY created_at DESC",
        [id],
      )
    ).rows;
  }
  @Get("documents/:id/comments") comments(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    this.lab.user(req);
    return this.lab.comments(id);
  }
  @Post("documents/:id/comments") async comment(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const user = this.lab.user(req);
    if (!["editor", "reviewer"].includes(user.role))
      deny(403, "当前成员没有评论权限");
    await ensure(id);
    if (
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 2000 ||
      ((!input.anchor?.from || !input.anchor?.to) && !input.anchor?.blockId)
    )
      deny(400, "评论或锚点无效");
    return access(id, async (doc) => {
      const resolved = resolveAnchor(doc, input.anchor);
      if (resolved.orphaned || resolved.text !== input.anchor.quote)
        deny(400, "评论选区已失效，请重新选择");
      const comment = {
        id: randomUUID(),
        doc_id: id,
        author: user.id,
        body: input.text,
        anchor: input.anchor,
      };
      await db.query(
        "INSERT INTO comments(id,doc_id,author,body,anchor) VALUES($1,$2,$3,$4,$5)",
        [comment.id, id, user.id, input.text, input.anchor],
      );
      return comment;
    });
  }
  @Post("documents/:id/reviews") async submit(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const user = this.lab.user(req, true);
    await ensure(id);
    return access(id, async (doc) => {
      const snapshot = docJSON(doc),
        idReview = randomUUID();
      await db.query(
        "INSERT INTO reviews(id,doc_id,submitter,reviewer,snapshot,hash) VALUES($1,$2,$3,$4,$5,$6)",
        [idReview, id, user.id, "carol", snapshot, hash(stable(snapshot))],
      );
      return { id: idReview, status: "pending", hash: hash(stable(snapshot)) };
    });
  }
  @Get("documents/:id/reviews") async reviews(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    this.lab.user(req);
    await ensure(id);
    return (
      await db.query(
        "SELECT * FROM reviews WHERE doc_id=$1 ORDER BY created_at DESC",
        [id],
      )
    ).rows;
  }
  @Post("documents/:id/reviews/:reviewId/decision") async decide(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("reviewId") reviewId: string,
    @Body() input: any,
  ) {
    const user = this.lab.user(req);
    if (user.role !== "reviewer") deny(403, "仅指定审核人可通过或退回");
    if (!["approved", "rejected"].includes(input.status))
      deny(400, "审核状态无效");
    const result = await db.query(
      "UPDATE reviews SET status=$1,decision=$2,decided_at=now() WHERE id=$3 AND doc_id=$4 AND reviewer=$5 AND status='pending' RETURNING *",
      [
        input.status,
        String(input.comment || "").slice(0, 2000),
        reviewId,
        id,
        user.id,
      ],
    );
    if (!result.rowCount) deny(409, "审核记录不存在或已处理");
    return result.rows[0];
  }
}
@Module({ controllers: [LabController], providers: [LabService] })
class LabModule {}

await db.query(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,ystate BYTEA NOT NULL,snapshot JSONB NOT NULL,revision BIGINT NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sync_bases(id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES documents(id),snapshot JSONB NOT NULL,hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sync_operations(doc_id TEXT NOT NULL REFERENCES documents(id),op_id TEXT NOT NULL,payload_hash TEXT NOT NULL,status INT NOT NULL,result JSONB NOT NULL,PRIMARY KEY(doc_id,op_id));
CREATE TABLE IF NOT EXISTS sync_conflicts(id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES documents(id),actor TEXT NOT NULL,markdown TEXT NOT NULL,details JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES documents(id),author TEXT NOT NULL,body TEXT NOT NULL,anchor JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES documents(id),submitter TEXT NOT NULL,reviewer TEXT NOT NULL,snapshot JSONB NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',decision TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),decided_at TIMESTAMPTZ);`);
const app = await NestFactory.create(LabModule, {
  logger: ["error", "warn", "log"],
});
const web = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web",
);
app.use(express.json({ limit: "3mb" }));
app.use((req: Request, res: Response, next: () => void) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.path.startsWith("/fixtures/")) {
    const id = req.path
      .split("/")
      .at(-1)!
      .replace(/\.svg$/, "");
    if (assets[id]) return res.type("image/svg+xml").send(assets[id]);
  }
  next();
});
app.use(express.static(web));
await app.init();
server = new Server({
  port: Number(process.env.PORT || 3000),
  address: "0.0.0.0",
  quiet: true,
  stopOnSignals: false,
  debounce: 150,
  maxDebounce: 500,
  async onRequest({ request, response }) {
    app.getHttpAdapter().getInstance()(request, response);
    return Promise.reject();
  },
  async onAuthenticate({ token, documentName, connectionConfig }) {
    const user = tokenUser(token);
    member(user);
    await ensure(documentName);
    connectionConfig.readOnly = user.role !== "editor";
    return user;
  },
  async onLoadDocument({ documentName }) {
    const row = (
      await db.query("SELECT ystate FROM documents WHERE id=$1", [documentName])
    ).rows[0];
    if (!row) throw new Error("Document not found");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.ystate);
    return doc;
  },
  async onStoreDocument({ documentName, document }) {
    const snapshot = docJSON(document);
    await db.query(
      "UPDATE documents SET ystate=$1,snapshot=$2,revision=revision+1,updated_at=now() WHERE id=$3",
      [Buffer.from(Y.encodeStateAsUpdate(document)), snapshot, documentName],
    );
  },
});
await server.listen();
console.log(`ANote validation listening on :${process.env.PORT || 3000}`);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void (async () => {
      await server.destroy();
      await app.close();
      await db.end();
      process.exit(0);
    })();
  });

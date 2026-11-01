import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Query,
  Req,
  Res,
  Body,
  Module,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { db, transaction } from "./database.js";
import {
  user,
  spaceRole,
  documentRole,
  readableDocumentSQL,
  type User,
} from "./auth.js";
import { fail, identifier, text, optionalText } from "./errors.js";
import {
  CHUNK_BYTES,
  MAX_ASSET_BYTES,
  storagePath,
  fileHash,
  receiveChunk,
  describeFile,
  sendFile,
} from "./storage.js";

const readableAssetSQL = `(a.owner_doc_id IS NULL OR EXISTS(SELECT 1 FROM documents d WHERE d.id=a.owner_doc_id AND ${readableDocumentSQL("d", "$5", "$6")}))`;
const hashInput = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail(400, "SHA-256 校验值无效");
  return value;
};
const uploadView = (row: any) => ({
  id: row.id,
  filename: row.filename,
  bytes: Number(row.bytes),
  hash: row.hash,
  offset: Number(row.offset_bytes),
  status: row.status,
  asset_id: row.asset_id,
  chunk_bytes: CHUNK_BYTES,
  updated_at: row.updated_at,
});
export const assetView = (row: any) => {
  const { storage_key, ...rest } = row;
  return {
    ...rest,
    bytes: Number(rest.bytes),
    revision: Number(rest.revision),
    url: `/api/assets/${row.id}/file`,
  };
};
export const localAssetPath = (row: any) =>
  `assets/${row.id}${/^\.[a-z0-9]{1,12}$/.test(path.extname(row.filename).toLowerCase()) ? path.extname(row.filename).toLowerCase() : ".bin"}`;
export async function assetFor(
  account: User,
  id: string,
  action: "read" | "edit" = "read",
  sql: Pick<PoolClient,"query"> = db,
) {
  const row = (await sql.query("SELECT * FROM assets WHERE id=$1", [id]))
    .rows[0];
  if (!row) fail(404, "资源不存在");
  if (row.owner_doc_id) await documentRole(account, row.owner_doc_id, action,false,false,sql);
  else if (
    action === "read" &&
    (
      await sql.query(
        "SELECT 1 FROM document_assets da WHERE da.asset_id=$1 AND effective_document_role($2,da.doc_id) IS NOT NULL LIMIT 1",
        [id, account.id],
      )
    ).rowCount
  ) {
    /* Legacy shared attachment referenced by an accessible migrated note. */
  } else if (
    action === "read" &&
    row.space_id === null &&
    (
      await sql.query(
        "SELECT 1 FROM experiments WHERE $1=ANY(asset_ids) AND effective_space_role($2,space_id) IS NOT NULL UNION ALL SELECT 1 FROM meetings WHERE $1=ANY(asset_ids) AND effective_space_role($2,space_id) IS NOT NULL LIMIT 1",
        [id, account.id],
      )
    ).rowCount
  ) {
    /* Surviving legacy records retain read access after the original library is removed. */
  } else await spaceRole(account, row.space_id, action,sql);
  return row;
}
async function ownedUpload(account: User, id: string) {
  const row = (
    await db.query("SELECT * FROM upload_sessions WHERE id=$1 AND actor=$2", [
      id,
      account.id,
    ])
  ).rows[0];
  if (!row) fail(404, "上传任务不存在");
  if (row.doc_id) await documentRole(account, row.doc_id, "edit");
  else await spaceRole(account, row.space_id, "edit");
  return row;
}
let activeTransfers = 0;
async function transfer<T>(fn: () => Promise<T>) {
  if (activeTransfers >= 4) fail(429, "同时传输数量已满，请稍后重试");
  activeTransfers++;
  try {
    return await fn();
  } finally {
    activeTransfers--;
  }
}
@Controller("api")
export class AssetsController {
  @Post("documents/:id/assets") async attach(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const account = await user(req),
      doc = await documentRole(account, identifier(id), "edit");
    if (
      !Array.isArray(input?.asset_ids) ||
      input.asset_ids.length < 1 ||
      input.asset_ids.length > 24
    )
      fail(400, "请选择 1–24 个资源");
    const results: any[] = [];
    for (const value of [...new Set<string>(input.asset_ids)]) {
      let asset = await assetFor(account, identifier(value));
      if (asset.space_id !== doc.space_id && asset.space_id !== null)
        fail(400, "只能引用当前知识库的资源");
      if (
        asset.space_id === null ||
        (asset.owner_doc_id && asset.owner_doc_id !== id)
      ) {
        asset = await transaction(async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            "storage:" + asset.storage_key,
          ]);
          const copy = (
            await client.query(
              `INSERT INTO assets(id,space_id,created_by,filename,title,description,tags,mime,bytes,hash,storage_key,kind,metadata,status,owner_doc_id)
          SELECT $1,$5,$2,filename,title,description,tags,mime,bytes,hash,storage_key,kind,metadata,status,$3 FROM assets WHERE id=$4 RETURNING *`,
              [randomUUID(), account.id, id, asset.id, doc.space_id],
            )
          ).rows[0];
          if (!copy) fail(404, "资源已删除，请刷新后重试");
          return copy;
        });
      }
      results.push({ ...assetView(asset), localPath: localAssetPath(asset) });
    }
    await transaction(async (client) => {
      for (const asset of results)
        await client.query(
          "INSERT INTO document_assets(doc_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [id, asset.id],
        );
    });
    return results;
  }
  @Get("documents/:id/assets/search") async search(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("q") query = "",
    @Query("kind") kind = "",
    @Query("offset") offset = "0",
  ) {
    const account = await user(req),
      doc = await documentRole(account, identifier(id));
    const start = Number(offset);
    if (!Number.isSafeInteger(start) || start < 0) fail(400, "分页位置无效");
    const rows = (
      await db.query(
        `SELECT a.*,d.title AS note_title FROM assets a LEFT JOIN documents d ON d.id=a.owner_doc_id
      WHERE (a.space_id=$1 OR (a.space_id IS NULL AND (a.owner_doc_id=$7 OR EXISTS(SELECT 1 FROM document_assets da WHERE da.asset_id=a.id AND da.doc_id=$7)))) AND NOT a.archived AND ($2='' OR a.title ILIKE '%'||$2||'%' OR a.filename ILIKE '%'||$2||'%' OR array_to_string(a.tags,' ') ILIKE '%'||$2||'%')
      AND ($3='' OR a.kind=$3) AND (a.owner_doc_id IS NULL OR ${readableDocumentSQL("d", "$5", "$6")})
      ORDER BY a.created_at DESC,a.id LIMIT 41 OFFSET $4`,
        [
          doc.space_id,
          optionalText(query, 200),
          optionalText(kind, 30),
          start,
          account.id,
          account.is_admin,
          id,
        ],
      )
    ).rows;
    return {
      items: rows.slice(0, 40).map(assetView),
      nextOffset: rows.length > 40 ? start + 40 : null,
    };
  }
  @Get("resource-limits") limits() {
    return { chunk_bytes: CHUNK_BYTES, max_asset_bytes: MAX_ASSET_BYTES };
  }
  @Get("uploads") async uploads(
    @Req() req: Request,
    @Query("space_id") value: string,
  ) {
    const account = await user(req),
      space = identifier(value);
    await spaceRole(account, space, "read");
    return (
      await db.query(
        "SELECT * FROM upload_sessions WHERE actor=$1 AND space_id=$2 AND status='uploading' AND ((doc_id IS NOT NULL AND effective_document_role($1,doc_id) IN ('admin','editor')) OR (doc_id IS NULL AND effective_space_role($1,space_id) IN ('admin','editor'))) ORDER BY updated_at DESC LIMIT 100",
        [account.id, space],
      )
    ).rows.map(uploadView);
  }
  @Post("uploads") async begin(@Req() req: Request, @Body() input: any) {
    const account = await user(req),
      space = identifier(input?.space_id);
    const docId = input?.doc_id ? identifier(input.doc_id) : null;
    if (docId) {
      const doc = await documentRole(account, docId, "edit");
      if (doc.space_id !== space) fail(400, "笔记不属于此知识库");
    } else await spaceRole(account, space, "edit");
    const filename = text(input?.filename, "文件名", 240),
      bytes = input?.bytes,
      hash = hashInput(input?.hash);
    if (
      /[\x00-\x1f/\\]/.test(filename) ||
      filename === "." ||
      filename === ".."
    )
      fail(400, "文件名无效");
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ASSET_BYTES)
      fail(413, "文件大小超出当前资源上限");
    return transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "upload:" + account.id + space + hash,
      ]);
      const existing = (
        await client.query(
          "SELECT * FROM upload_sessions WHERE actor=$1 AND space_id=$2 AND hash=$3 AND bytes=$4 AND filename=$5 AND doc_id IS NOT DISTINCT FROM $6 AND status='uploading' LIMIT 1",
          [account.id, space, hash, bytes, filename, docId],
        )
      ).rows[0];
      if (existing) return uploadView(existing);
      const count = (
        await client.query(
          "SELECT count(*)::int AS count FROM upload_sessions WHERE actor=$1 AND status='uploading'",
          [account.id],
        )
      ).rows[0].count;
      if (count >= 100) fail(429, "待续传任务过多，请先完成或取消");
      return uploadView(
        (
          await client.query(
            "INSERT INTO upload_sessions(id,space_id,actor,filename,bytes,hash,doc_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [randomUUID(), space, account.id, filename, bytes, hash, docId],
          )
        ).rows[0],
      );
    });
  }
  @Get("uploads/:id") async upload(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return uploadView(await ownedUpload(await user(req), identifier(id)));
  }
  @Put("uploads/:id/chunk") async chunk(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    const id = identifier(value),
      account = await user(req),
      row = await ownedUpload(account, id);
    const offset = Number(req.headers["upload-offset"]),
      length = Number(
        req.headers["content-length"] || req.headers["upload-length"],
      ),
      hash = hashInput(req.headers["x-chunk-sha256"]);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > CHUNK_BYTES ||
      offset + length > Number(row.bytes)
    )
      fail(400, "分块范围无效");
    if (row.status !== "uploading") fail(409, "任务已经结束");
    return transfer(async () => {
      const piece = storagePath("uploads", randomUUID() + ".chunk");
      try {
        await receiveChunk(req, piece, length, hash);
        return await transaction(async (client) => {
          const current = (
            await client.query(
              "SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
          if (!current) fail(404, "上传任务已删除");
          if (current.status !== "uploading") fail(409, "任务已经结束");
          if (Number(current.offset_bytes) !== offset) {
            const previous = (
              await client.query(
                "SELECT * FROM upload_chunks WHERE upload_id=$1 AND offset_bytes=$2",
                [id, offset],
              )
            ).rows[0];
            if (previous && previous.hash === hash && previous.bytes === length)
              return uploadView(current);
            fail(409, "续传位置已变化，请重新读取任务进度");
          }
          const target = storagePath("uploads", id + ".part");
          const handle = await fs.open(target, "a", 0o600);
          try {
            await handle.truncate(offset);
          } finally {
            await handle.close();
          }
          await pipeline(
            createReadStream(piece),
            createWriteStream(target, { flags: "a" }),
          );
          const stable = await fs.open(target, "r+");
          try {
            await stable.sync();
          } finally {
            await stable.close();
          }
          await client.query(
            "INSERT INTO upload_chunks(upload_id,offset_bytes,bytes,hash) VALUES($1,$2,$3,$4)",
            [id, offset, length, hash],
          );
          return uploadView(
            (
              await client.query(
                "UPDATE upload_sessions SET offset_bytes=$2,updated_at=now() WHERE id=$1 RETURNING *",
                [id, offset + length],
              )
            ).rows[0],
          );
        });
      } finally {
        await fs.rm(piece, { force: true });
      }
    });
  }
  @Delete("uploads/:id") async cancel(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    const id = identifier(value);
    await ownedUpload(await user(req), id);
    await transaction(async (client) => {
      const row = (
        await client.query(
          "SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (row.status === "complete") fail(409, "已完成的资源不能取消上传");
      await client.query(
        "UPDATE upload_sessions SET status='cancelled',updated_at=now() WHERE id=$1",
        [id],
      );
      await fs.rm(storagePath("uploads", id + ".part"), { force: true });
    });
    return { ok: true };
  }
  @Post("uploads/:id/complete") async complete(
    @Req() req: Request,
    @Param("id") value: string,
  ) {
    const id = identifier(value),
      account = await user(req);
    const upload = await ownedUpload(account, id);
    return transfer(async () => {
      const result = await transaction(async (client) => {
        const parent = await client.query(
          "SELECT id FROM spaces WHERE id=$1 FOR KEY SHARE",
          [upload.space_id],
        );
        if (!parent.rowCount) fail(404, "知识库已删除");
        if (
          upload.doc_id &&
          !(
            await client.query(
              "SELECT id FROM documents WHERE id=$1 FOR KEY SHARE",
              [upload.doc_id],
            )
          ).rowCount
        )
          fail(404, "笔记已删除");
        const row = (
          await client.query(
            "SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!row) fail(404, "上传任务已删除");
        if (row.status === "complete")
          return assetView(
            (
              await client.query("SELECT * FROM assets WHERE id=$1", [
                row.asset_id,
              ])
            ).rows[0],
          );
        if (row.status !== "uploading" || row.offset_bytes !== row.bytes)
          fail(409, "文件尚未传输完整");
        const staging = storagePath("uploads", id + ".part"),
          key = id + ".bin",
          original = storagePath("originals", key);
        let file = staging;
        try {
          await fs.access(staging);
        } catch {
          file = original;
        }
        if (
          (await fs.stat(file)).size !== Number(row.bytes) ||
          (await fileHash(file)) !== row.hash
        )
          fail(422, "完整文件校验失败，请取消任务后重新上传");
        const { kind, mime, metadata } = await describeFile(
          file,
          row.filename,
          Number(row.bytes),
        );
        if (file === staging) {
          try {
            await fs.rename(staging, original);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
            const temporary = storagePath("originals", id + ".copy");
            await fs.copyFile(staging, temporary);
            const handle = await fs.open(temporary, "r+");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
            await fs.rename(temporary, original);
          }
          const directory = await fs.open(path.dirname(original), "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        const asset = (
          await client.query(
            "INSERT INTO assets(id,space_id,created_by,filename,title,mime,bytes,hash,storage_key,kind,metadata,status,owner_doc_id) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,'ready',$11) RETURNING *",
            [
              id,
              row.space_id,
              account.id,
              row.filename,
              mime,
              row.bytes,
              row.hash,
              key,
              kind,
              JSON.stringify(metadata),
              row.doc_id,
            ],
          )
        ).rows[0];
        if (["image", "video", "audio"].includes(kind))
          await client.query(
            "INSERT INTO jobs(id,kind,asset_id) VALUES($1,'probe',$2)",
            [randomUUID(), id],
          );
        await client.query(
          "UPDATE upload_sessions SET status='complete',asset_id=$2,updated_at=now() WHERE id=$1",
          [id, id],
        );
        await client.query(
          "INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'asset.upload',$2,$3)",
          [
            account.id,
            id,
            JSON.stringify({ bytes: Number(row.bytes), hash: row.hash }),
          ],
        );
        return assetView(asset);
      });
      await fs.rm(storagePath("uploads", id + ".part"), { force: true });
      return result;
    });
  }
  @Get("assets") async list(
    @Req() req: Request,
    @Query("space_id") value: string,
    @Query("q") query = "",
    @Query("kind") kind = "",
    @Query("archived") archived = "false",
  ) {
    const account = await user(req),
      space = identifier(value);
    await spaceRole(account, space);
    return (
      await db.query(
        `SELECT a.* FROM assets a WHERE ${readableAssetSQL} AND space_id=$1 AND archived=$2 AND ($3='' OR title ILIKE '%'||$3||'%' OR filename ILIKE '%'||$3||'%' OR description ILIKE '%'||$3||'%' OR array_to_string(tags,' ') ILIKE '%'||$3||'%') AND ($4='' OR kind=$4) ORDER BY created_at DESC LIMIT 500`,
        [
          space,
          archived === "true",
          optionalText(query, 200),
          optionalText(kind, 30),
          account.id,
          account.is_admin,
        ],
      )
    ).rows.map(assetView);
  }
  @Get("assets/:id") async get(@Req() req: Request, @Param("id") id: string) {
    const account = await user(req),
      asset = await assetFor(account, identifier(id));
    const role = asset.owner_doc_id
      ? (await documentRole(account, asset.owner_doc_id)).role
      : asset.space_id
        ? await spaceRole(account, asset.space_id)
        : "viewer";
    return {
      ...assetView(asset),
      can_edit: ["admin", "editor"].includes(role),
      jobs: (
        await db.query(
          "SELECT id,kind,status,attempts,error,progress FROM jobs WHERE asset_id=$1 ORDER BY created_at DESC",
          [id],
        )
      ).rows,
    };
  }
  @Patch("assets/:id") async metadata(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const account = await user(req),
      asset = await assetFor(account, identifier(id), "edit");
    if (!Number.isSafeInteger(input?.revision)) fail(400, "请提供资源版本");
    const title =
        input.title === undefined
          ? asset.title
          : text(input.title, "标题", 240),
      description =
        input.description === undefined
          ? asset.description
          : optionalText(input.description, 10000),
      tags = input.tags === undefined ? asset.tags : input.tags,
      archived = input.archived === undefined ? asset.archived : input.archived;
    if (
      !Array.isArray(tags) ||
      tags.length > 30 ||
      tags.some((v) => typeof v !== "string" || !v.trim() || v.length > 80) ||
      typeof archived !== "boolean"
    )
      fail(400, "标签或归档状态无效");
    const result = (
      await db.query(
        "UPDATE assets SET title=$2,description=$3,tags=$4,archived=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$6 RETURNING *",
        [
          id,
          title,
          description,
          [...new Set(tags.map((v) => v.trim()))],
          archived,
          input.revision,
        ],
      )
    ).rows[0];
    if (!result) fail(409, "资源资料已被其他成员修改，请刷新后重试");
    return assetView(result);
  }
  @Get("assets/:id/file") async file(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") id: string,
  ) {
    const row = await assetFor(await user(req), identifier(id));
    await sendFile(req, res, storagePath("originals", row.storage_key), {
      mime: row.mime,
      filename: row.filename,
      hash: row.hash,
      inline:
        (["image", "video", "audio", "text"].includes(row.kind) ||
          row.mime === "application/pdf") &&
        req.query.download !== "1",
    });
  }
  @Get("assets/:id/thumbnail") async thumbnail(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") id: string,
  ) {
    const row = await assetFor(await user(req), identifier(id)),
      thumbnail = row.metadata?.thumbnail;
    if (!thumbnail?.key) fail(404, "预览图尚未生成");
    await sendFile(req, res, storagePath("derived", thumbnail.key), {
      mime: "image/jpeg",
      filename: row.title + ".jpg",
      hash: thumbnail.hash,
      inline: true,
    });
  }
  @Post("assets/:id/retry") async retry(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    await assetFor(await user(req), identifier(id), "edit");
    await db.query(
      "UPDATE jobs SET status='pending',attempts=0,error=NULL,progress=0 WHERE asset_id=$1 AND status='failed'",
      [id],
    );
    return { ok: true };
  }
}
@Module({ controllers: [AssetsController] })
export class AssetsModule {}

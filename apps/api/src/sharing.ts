import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Inject,
  Param,
  Req,
  Res,
  Body,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { db, digest, transaction } from "./database.js";
import { user, documentRole, spaceRole } from "./auth.js";
import { Documents } from "./documents.js";
import { fail, identifier } from "./errors.js";
import { externalSharingAllowed } from "./teams.js";
import { platformConfig } from "./platform.js";
import { sendFile, storagePath } from "./storage.js";

async function publicNote(token: string) {
  if (!/^[\w-]{43}$/.test(token)) fail(404, "分享已失效");
  const row = (
    await db.query(
      `SELECT d.id,d.title,d.snapshot,d.updated_at FROM document_share_links l JOIN documents d ON d.id=l.doc_id
    WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>now()) AND NOT d.archived AND d.deleted_at IS NULL`,
      [digest(token)],
    )
  ).rows[0];
  if (!row || !(await externalSharingAllowed(row.id))) fail(404, "分享已失效");
  return row;
}
function references(snapshot: any) {
  const ids = new Set<string>();
  const visit = (node: any) => {
    if (node.type === "mediaResource" && node.attrs?.assetId)
      ids.add(node.attrs.assetId);
    if (node.type === "imageComparison")
      for (const image of node.attrs?.images || [])
        if (image.assetId) ids.add(image.assetId);
    for (const child of node.content || []) visit(child);
  };
  visit(snapshot);
  return [...ids];
}
async function publicAssets(doc: any) {
  return (
    await db.query(
      `SELECT a.* FROM assets a WHERE a.id=ANY($1::text[]) AND
    (a.owner_doc_id=$2 OR (a.owner_doc_id IS NULL AND EXISTS(SELECT 1 FROM document_assets da WHERE da.doc_id=$2 AND da.asset_id=a.id)))`,
      [references(doc.snapshot), doc.id],
    )
  ).rows;
}
@Controller("api")
export class SharingController {
  constructor(@Inject(Documents) private readonly documents: Documents) {}
  @Get("documents/:id/sharing") async get(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const doc = await documentRole(await user(req), identifier(id));
    const space = (
      await db.query("SELECT kind FROM spaces WHERE id=$1", [doc.space_id])
    ).rows[0];
    const reviewers = (
      await db.query(
        `SELECT u.id,u.name FROM users u LEFT JOIN space_members m ON m.user_id=u.id AND m.space_id=$2 LEFT JOIN document_collaborators c ON c.user_id=u.id AND c.doc_id=$1
      WHERE u.active AND (u.id=$3 OR c.role='reviewer' OR ($4='team' AND c.user_id IS NULL AND m.role IN ('admin','reviewer'))) ORDER BY u.name`,
        [id, doc.space_id, doc.created_by, doc.visibility],
      )
    ).rows;
    if (doc.role !== "admin")
      return { visibility: doc.visibility, can_manage: false, reviewers };
    const collaborators = (
      await db.query(
        `SELECT c.user_id,c.role,u.name FROM document_collaborators c JOIN users u ON u.id=c.user_id WHERE c.doc_id=$1 ORDER BY u.name`,
        [id],
      )
    ).rows;
    const links = (
      await db.query(
        `SELECT id,created_at,expires_at,revoked_at FROM document_share_links WHERE doc_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`,
        [id],
      )
    ).rows;
    return {
      reviewers,
      space_kind: space.kind,
      owner_id: doc.created_by,
      visibility: doc.visibility,
      access_revision: Number(doc.access_revision),
      can_manage: doc.role === "admin",
      collaborators,
      links,
    };
  }
  @Get("documents/:id/share-candidates") async candidates(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const doc = await documentRole(await user(req), identifier(id), "manage");
    const space = (
      await db.query("SELECT kind,team_id FROM spaces WHERE id=$1", [doc.space_id])
    ).rows[0];
    if (space.kind !== "team" || !space.team_id) return [];
    return (
      await db.query(
        `SELECT u.id,u.name,u.username FROM users u JOIN team_members m ON m.user_id=u.id AND m.team_id=$2 WHERE u.active AND u.id<>$1 AND effective_space_role(u.id,$3) IS NOT NULL ORDER BY u.name`,
        [doc.created_by, space.team_id, doc.space_id],
      )
    ).rows;
  }
  @Patch("documents/:id/sharing") async update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const account = await user(req),
      doc = await documentRole(account, identifier(id), "manage");
    if (
      !["private", "team"].includes(input?.visibility) ||
      !Array.isArray(input?.collaborators) ||
      input.collaborators.length > 100 ||
      !Number.isSafeInteger(input.access_revision)
    )
      fail(400, "共享设置无效");
    const space = (
      await db.query("SELECT kind FROM spaces WHERE id=$1", [doc.space_id])
    ).rows[0];
    if (input.visibility === "team") {
      if (space.kind !== "team")
        fail(400, "个人知识库中的笔记请使用指定成员或外链共享");
      await spaceRole(account, doc.space_id, "create");
    }
    const people = input.only_me ? [] : input.collaborators;
    if (input.only_me && input.visibility !== "private")
      fail(400, "仅自己可见需要私有权限");
    for (const person of people) {
      if (
        !["viewer", "reviewer", "editor"].includes(person.role) ||
        identifier(person.user_id) === doc.created_by
      )
        fail(400, "协作者无效");
      if (space.kind === "team")
        await spaceRole(
          { ...account, id: person.user_id, is_admin: false },
          doc.space_id,
        );
      else if (
        !(
          await db.query("SELECT id FROM users WHERE id=$1 AND active=true", [
            person.user_id,
          ])
        ).rowCount
      )
        fail(400, "成员无效");
    }
    await transaction(async (client) => {
      const changed = await client.query(
        "UPDATE documents SET visibility=$2,access_revision=access_revision+1 WHERE id=$1 AND access_revision=$3 RETURNING id",
        [id, input.visibility, input.access_revision],
      );
      if (!changed.rowCount) fail(409, "共享设置已变化，请关闭后重新打开");
      await client.query("DELETE FROM document_collaborators WHERE doc_id=$1", [
        id,
      ]);
      for (const person of people)
        await client.query(
          "INSERT INTO document_collaborators(doc_id,user_id,role) VALUES($1,$2,$3)",
          [id, person.user_id, person.role],
        );
      if (input.only_me)
        await client.query(
          "UPDATE document_share_links SET revoked_at=now() WHERE doc_id=$1 AND revoked_at IS NULL",
          [id],
        );
    });
    // Re-authenticate every connection: revoked readers must stop receiving broadcasts.
    this.documents.disconnect(id);
    return this.get(req, id);
  }
  @Post("documents/:id/sharing/links") async createLink(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const account = await user(req);
    return transaction(async (client) => {
      await client.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [
        identifier(id),
      ]);
      await documentRole(account, identifier(id), "manage");
      if (!(await externalSharingAllowed(id))) fail(403, "团队已关闭对外分享");
      const days = input?.days === undefined ? 7 : input.days;
      if (days !== null && ![1, 7, 30].includes(days)) fail(400, "请选择 1、7、30 天或永久有效");
      const token = randomBytes(32).toString("base64url"),
        linkId = randomUUID();
      const link = (
        await client.query(
          "INSERT INTO document_share_links(id,doc_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id,expires_at",
          [
            linkId,
            id,
            digest(token),
            account.id,
            days === null ? null : new Date(Date.now() + days * 86400000),
          ],
        )
      ).rows[0];
      return {
        ...link,
        path: "/share/" + token,
        url: platformConfig().public_origin
          ? platformConfig().public_origin + "/share/" + token
          : null,
      };
    });
  }
  @Delete("documents/:id/sharing/links/:link") async revoke(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("link") link: string,
  ) {
    await documentRole(await user(req), identifier(id), "manage");
    await db.query(
      "UPDATE document_share_links SET revoked_at=now() WHERE doc_id=$1 AND id=$2",
      [id, identifier(link)],
    );
    return { ok: true };
  }
  @Get("public/notes/:token") async public(
    @Param("token") token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const doc = await publicNote(token),
      assets = new Set((await publicAssets(doc)).map((a) => a.id));
    const rewrite = (node: any): any => {
      const copy = { ...node };
      if (node.attrs) copy.attrs = { ...node.attrs };
      if (node.type === "mediaResource")
        copy.attrs.src = assets.has(node.attrs.assetId)
          ? `/api/public/notes/${token}/assets/${node.attrs.assetId}`
          : "";
      if (node.type === "imageComparison")
        copy.attrs.images = (node.attrs.images || [])
          .filter((a: any) => assets.has(a.assetId))
          .map((a: any) => ({
            ...a,
            src: `/api/public/notes/${token}/assets/${a.assetId}`,
          }));
      if (node.content) copy.content = node.content.map(rewrite);
      return copy;
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return {
      title: doc.title,
      snapshot: rewrite(doc.snapshot),
      updated_at: doc.updated_at,
    };
  }
  @Get("public/notes/:token/assets/:asset") async file(
    @Req() req: Request,
    @Res() res: Response,
    @Param("token") token: string,
    @Param("asset") asset: string,
  ) {
    const doc = await publicNote(token),
      row = (await publicAssets(doc)).find((a) => a.id === asset);
    if (!row) fail(404, "附件不存在或未共享");
    await sendFile(req, res, storagePath("originals", row.storage_key), {
      mime: row.mime,
      filename: row.filename,
      hash: row.hash,
      inline:
        ["image", "video", "audio", "text"].includes(row.kind) &&
        req.query.download !== "1",
    });
  }
}

import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Body,
} from "@nestjs/common";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { db, transaction } from "./database.js";
import { user, type User } from "./auth.js";
import { Documents } from "./documents.js";
import { fail, identifier } from "./errors.js";
import {
  purgeTrash,
  collectStorage,
  type TrashKind,
} from "./trash-maintenance.js";

@Controller("api")
export class TrashController {
  constructor(@Inject(Documents) private readonly documents: Documents) {}

  @Get("trash/teams") async teams(@Req() req: Request) {
    const account = await user(req);
    return (
      await db.query(
        "SELECT t.id,t.name,t.deleted_at,t.trash_batch,t.deleted_at+interval '30 days' AS expires_at FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.role='admin' WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC",
        [account.id],
      )
    ).rows;
  }
  @Get("trash/spaces") async spaces(@Req() req: Request) {
    const account = await user(req);
    return (
      await db.query(
        "SELECT s.id,s.name,s.kind,s.deleted_at,s.trash_batch,s.deleted_at+interval '30 days' AS expires_at,t.name AS team_name FROM spaces s LEFT JOIN teams t ON t.id=s.team_id WHERE s.deleted_at IS NOT NULL AND t.deleted_at IS NULL AND effective_space_role_with_deleted($1,s.id)='admin' ORDER BY s.deleted_at DESC",
        [account.id],
      )
    ).rows;
  }
  @Delete("trash/:kind/:id") async purge(
    @Req() req: Request,
    @Param("kind") kind: TrashKind,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const result = await purgeTrash(kind, identifier(id), {
      account: await user(req),
      token: input?.deletion_token,
    });
    for (const noteId of result?.noteIds || [])
      this.documents.disconnect(noteId);
    await collectStorage();
    return { ok: true, shared_assets_preserved: result?.preservedAssets || 0 };
  }
  @Delete("teams/:id") async deleteTeam(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.change(await user(req), identifier(id), "team", false);
  }
  @Post("teams/:id/restore-deleted") async restoreTeam(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.change(await user(req), identifier(id), "team", true);
  }
  @Delete("spaces/:id") async deleteSpace(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.change(await user(req), identifier(id), "space", false);
  }
  @Post("spaces/:id/restore-deleted") async restoreSpace(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.change(await user(req), identifier(id), "space", true);
  }
  private async change(
    account: User,
    id: string,
    kind: "team" | "space",
    restore: boolean,
  ) {
    const team = kind === "team";
    // Table names and scopes are internal constants; all identifiers are parameters.
    const table = team ? "teams" : "spaces";
    const scope = team
      ? "SELECT id FROM spaces WHERE team_id=$1"
      : "SELECT id FROM spaces WHERE id=$1";
    const authorize = async (query: typeof db.query) => {
      const row = team
        ? (
            await query(
              "SELECT t.*,m.role FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$2 WHERE t.id=$1 FOR UPDATE OF t",
              [id, account.id],
            )
          ).rows[0]
        : (
            await query(
              "SELECT s.*,t.deleted_at AS parent_deleted,t.archived AS parent_archived,effective_space_role_with_deleted($2,s.id) AS role FROM spaces s LEFT JOIN teams t ON t.id=s.team_id WHERE s.id=$1 FOR UPDATE OF s",
              [id, account.id],
            )
          ).rows[0];
      if (!row || row.role !== "admin")
        fail(
          403,
          team
            ? "仅团队管理员可删除或恢复团队"
            : "仅知识库管理者可删除或恢复知识库，请先恢复所属团队",
        );
      if (!team && (row.parent_deleted || row.parent_archived))
        fail(409, "请先恢复所属团队");
      return row;
    };
    // Check before flushing, then check again under row locks before mutation.
    await transaction((client) =>
      authorize(client.query.bind(client) as typeof db.query),
    );
    const ids = (
      await db.query(
        `SELECT id FROM documents WHERE space_id IN (${scope}) AND deleted_at IS NULL`,
        [id],
      )
    ).rows.map((row) => row.id as string);
    if (!restore) await this.documents.checkpointLive(ids, account.id);
    await transaction(async (client) => {
      const row = await authorize(client.query.bind(client) as typeof db.query);
      if (restore ? !row.deleted_at : !!row.deleted_at) return;
      const batch = restore ? row.trash_batch : randomUUID();
      if (restore) {
        await client.query(
          `UPDATE ${table} SET deleted_at=NULL,deleted_by=NULL,trash_batch=NULL WHERE id=$1`,
          [id],
        );
        if (team)
          await client.query(
            "UPDATE spaces SET deleted_at=NULL,deleted_by=NULL,trash_batch=NULL WHERE team_id=$1 AND trash_batch=$2",
            [id, batch],
          );
        await client.query(
          `UPDATE documents SET deleted_at=NULL,deleted_by=NULL,trash_batch=NULL,access_revision=access_revision+1 WHERE space_id IN (${scope}) AND trash_batch=$2`,
          [id, batch],
        );
      } else {
        await client.query(
          `UPDATE ${table} SET deleted_at=now(),deleted_by=$2,trash_batch=$3 WHERE id=$1`,
          [id, account.id, batch],
        );
        if (team)
          await client.query(
            "UPDATE spaces SET deleted_at=now(),deleted_by=$2,trash_batch=$3 WHERE team_id=$1 AND deleted_at IS NULL",
            [id, account.id, batch],
          );
        await client.query(
          `UPDATE documents SET deleted_at=now(),deleted_by=$2,trash_batch=$3,access_revision=access_revision+1 WHERE space_id IN (${scope}) AND deleted_at IS NULL`,
          [id, account.id, batch],
        );
        await client.query(
          `UPDATE document_share_links SET revoked_at=now() WHERE doc_id IN (SELECT id FROM documents WHERE space_id IN (${scope})) AND revoked_at IS NULL`,
          [id],
        );
        if (team)
          await client.query(
            "UPDATE team_invites SET revoked_at=now() WHERE team_id=$1 AND revoked_at IS NULL AND accepted_by IS NULL",
            [id],
          );
      }
      await client.query(
        "INSERT INTO audit_events(actor,action,target) VALUES($1,$2,$3)",
        [account.id, kind + (restore ? ".restore" : ".trash"), id],
      );
    });
    if (!restore) for (const note of ids) this.documents.disconnect(note);
    return { ok: true };
  }
}

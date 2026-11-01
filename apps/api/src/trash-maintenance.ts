import fs from "node:fs/promises";
import { db, transaction } from "./database.js";
import type { User } from "./auth.js";
import { fail } from "./errors.js";
import { storagePath } from "./storage.js";
import type { Documents } from "./documents.js";
export const TRASH_DAYS = 30;
export type TrashKind = "documents" | "spaces" | "teams";
export async function purgeTrash(
  kind: TrashKind,
  id: string,
  options: { account?: User; token?: string; automatic?: boolean } = {},
) {
  if (!["documents", "spaces", "teams"].includes(kind))
    fail(400, "回收站类型无效");
  return transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('anote:trash-purge'))",
    );
    const root = (
      await client.query(
        `SELECT *,deleted_at<=now()-interval '30 days' AS expired FROM ${kind} WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!root) {
      if (options.automatic) return null;
      fail(404, "回收站内容不存在");
    }
    if (!root.deleted_at) {
      if (options.automatic) return null;
      fail(409, "内容已恢复，不能彻底删除");
    }
    if (options.automatic && !root.expired) return null;
    if (!options.automatic) {
      if (!options.account) fail(403, "需要登录");
      const role =
        kind === "teams"
          ? (
              await client.query(
                "SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2",
                [id, options.account.id],
              )
            ).rows[0]?.role
          : kind === "spaces"
            ? (
                await client.query(
                  "SELECT effective_space_role_with_deleted($2,s.id) AS role FROM spaces s LEFT JOIN teams t ON t.id=s.team_id WHERE s.id=$1 AND t.deleted_at IS NULL",
                  [id, options.account.id],
                )
              ).rows[0]?.role
            : (
                await client.query(
                  "SELECT effective_document_role_with_deleted($2,$1) AS role",
                  [id, options.account.id],
                )
              ).rows[0]?.role;
      if (role !== "admin") fail(403, "没有彻底删除此内容的管理权限");
      if (!options.token || options.token !== root.trash_batch)
        fail(409, "删除状态已变化，请刷新回收站后重试");
    }
    const spaces =
      kind === "teams"
        ? (
            await client.query(
              "SELECT id,deleted_at,deleted_at<=now()-interval '30 days' AS expired FROM spaces WHERE team_id=$1 ORDER BY id FOR UPDATE",
              [id],
            )
          ).rows
        : kind === "spaces"
          ? [root]
          : [];
    const spaceIds = spaces.map((row) => row.id);
    const notes =
      kind === "documents"
        ? [root]
        : (
            await client.query(
              "SELECT id,deleted_at,deleted_at<=now()-interval '30 days' AS expired FROM documents WHERE space_id=ANY($1::text[]) ORDER BY id FOR UPDATE",
              [spaceIds],
            )
          ).rows;
    if ([...spaces, ...notes].some((row) => !row.deleted_at))
      fail(409, "存在未删除的下级内容，请先恢复后重新删除");
    if (options.automatic && [...spaces, ...notes].some((row) => !row.expired))
      return null;
    const noteIds = notes.map((row) => row.id);
    const assets = (
      await client.query(
        "SELECT * FROM assets a WHERE owner_doc_id=ANY($1::text[]) OR space_id=ANY($2::text[]) OR (space_id IS NULL AND (EXISTS(SELECT 1 FROM document_assets da WHERE da.asset_id=a.id AND da.doc_id=ANY($1::text[])) OR EXISTS(SELECT 1 FROM experiments e WHERE a.id=ANY(e.asset_ids) AND e.space_id=ANY($2::text[])) OR EXISTS(SELECT 1 FROM meetings m WHERE a.id=ANY(m.asset_ids) AND m.space_id=ANY($2::text[])))) ORDER BY id FOR UPDATE",
        [noteIds, spaceIds],
      )
    ).rows;
    const preserved: string[] = [],
      removed: any[] = [];
    for (const asset of assets) {
      const outside = (
        await client.query(
          "SELECT 1 FROM document_assets WHERE asset_id=$1 AND NOT(doc_id=ANY($2::text[])) UNION ALL SELECT 1 FROM experiments WHERE $1=ANY(asset_ids) AND NOT(space_id=ANY($3::text[])) UNION ALL SELECT 1 FROM meetings WHERE $1=ANY(asset_ids) AND NOT(space_id=ANY($3::text[])) LIMIT 1",
          [asset.id, noteIds, spaceIds],
        )
      ).rowCount;
      if (
        outside ||
        (asset.owner_doc_id && !noteIds.includes(asset.owner_doc_id))
      ) {
        preserved.push(asset.id);
        await client.query(
          "UPDATE assets SET owner_doc_id=CASE WHEN owner_doc_id=ANY($3::text[]) THEN NULL ELSE owner_doc_id END,space_id=CASE WHEN space_id=ANY($2::text[]) THEN NULL ELSE space_id END WHERE id=$1",
          [asset.id, spaceIds, noteIds],
        );
      } else removed.push(asset);
    }
    const assetIds = removed.map((row) => row.id);
    const uploads = (
      await client.query(
        "SELECT id FROM upload_sessions WHERE doc_id=ANY($1::text[]) OR space_id=ANY($2::text[]) OR asset_id=ANY($3::text[]) ORDER BY id FOR UPDATE",
        [noteIds, spaceIds, assetIds],
      )
    ).rows;
    const jobs = (
      await client.query(
        "SELECT asset_id,lease_id FROM jobs WHERE asset_id=ANY($1::text[]) FOR UPDATE",
        [assetIds],
      )
    ).rows;
    const queue = async (area: string, key: string, delay = false) => {
      storagePath(area as any, key);
      await client.query(
        "INSERT INTO storage_gc(area,key,not_before) VALUES($1,$2,now()+CASE WHEN $3 THEN interval '1 hour' ELSE interval '0 seconds' END) ON CONFLICT(area,key) DO UPDATE SET not_before=GREATEST(storage_gc.not_before,excluded.not_before)",
        [area, key, delay],
      );
    };
    for (const asset of removed) {
      await queue("originals", asset.storage_key);
      await queue("derived", asset.id + ".jpg", true);
      if (
        asset.metadata?.thumbnail?.key &&
        asset.metadata.thumbnail.key !== asset.id + ".jpg"
      )
        await queue("derived", asset.metadata.thumbnail.key, true);
    }
    for (const upload of uploads) {
      await queue("uploads", upload.id + ".part");
      await queue("originals", upload.id + ".bin");
      await queue("originals", upload.id + ".copy");
    }
    for (const job of jobs)
      if (job.lease_id)
        await queue(
          "derived",
          job.asset_id + "." + job.lease_id + ".jpg",
          true,
        );
    const uploadIds = uploads.map((row) => row.id);
    const integrations=(await client.query("SELECT id FROM mcp_uploads WHERE doc_id=ANY($1::text[]) OR space_id=ANY($2::text[]) FOR UPDATE",[noteIds,spaceIds])).rows;
    for(const upload of integrations){
      await queue("uploads","mcp-"+upload.id+".part");
      await queue("originals","mcp-"+upload.id+".bin.copy");
      if(!(await client.query("SELECT 1 FROM assets WHERE id=$1 AND NOT(id=ANY($2::text[]))",[upload.id,assetIds])).rowCount)await queue("originals","mcp-"+upload.id+".bin");
    }
    await client.query("DELETE FROM mcp_uploads WHERE id=ANY($1::text[])",[integrations.map(row=>row.id)]);
    await client.query("DELETE FROM mcp_changes WHERE doc_id=ANY($1::text[]) OR space_id=ANY($2::text[])",[noteIds,spaceIds]);
    await client.query(
      "DELETE FROM upload_chunks WHERE upload_id=ANY($1::text[])",
      [uploadIds],
    );
    await client.query("DELETE FROM upload_sessions WHERE id=ANY($1::text[])", [
      uploadIds,
    ]);
    await client.query("DELETE FROM jobs WHERE asset_id=ANY($1::text[])", [
      assetIds,
    ]);
    await client.query(
      "DELETE FROM document_assets WHERE doc_id=ANY($1::text[])",
      [noteIds],
    );
    await client.query("DELETE FROM assets WHERE id=ANY($1::text[])", [
      assetIds,
    ]);
    await client.query(
      "UPDATE teams SET announcement_doc_id=NULL WHERE announcement_doc_id=ANY($1::text[])",
      [noteIds],
    );
    for (const table of ["experiments", "meetings"]) {
      await client.query(
        `UPDATE ${table} SET document_id=NULL WHERE document_id=ANY($1::text[])`,
        [noteIds],
      );
      await client.query(
        `DELETE FROM ${table} WHERE space_id=ANY($1::text[])`,
        [spaceIds],
      );
    }
    for (const table of [
      "comments",
      "reviews",
      "document_versions",
      "sync_bases",
      "sync_operations",
      "sync_conflicts",
      "document_collaborators",
      "document_share_links",
    ])
      await client.query(`DELETE FROM ${table} WHERE doc_id=ANY($1::text[])`, [
        noteIds,
      ]);
    await client.query("DELETE FROM documents WHERE id=ANY($1::text[])", [
      noteIds,
    ]);
    await client.query("DELETE FROM folders WHERE space_id=ANY($1::text[])", [
      spaceIds,
    ]);
    await client.query(
      "DELETE FROM space_members WHERE space_id=ANY($1::text[])",
      [spaceIds],
    );
    await client.query("DELETE FROM spaces WHERE id=ANY($1::text[])", [
      spaceIds,
    ]);
    if (kind === "teams") {
      await client.query("DELETE FROM team_invites WHERE team_id=$1", [id]);
      await client.query("DELETE FROM team_members WHERE team_id=$1", [id]);
      await client.query("DELETE FROM teams WHERE id=$1", [id]);
    }
    await client.query(
      "INSERT INTO audit_events(actor,action,target,detail) VALUES($1,$2,$3,$4)",
      [
        options.account?.id || null,
        options.automatic ? "trash.expire" : "trash.purge",
        id,
        {
          kind,
          documents: noteIds.length,
          spaces: spaceIds.length,
          assets: assetIds.length,
          shared_assets_preserved: preserved.length,
        },
      ],
    );
    return { ok: true, noteIds, preservedAssets: preserved.length };
  });
}
export async function collectStorage() {
  const candidates = (
    await db.query(
      "SELECT area,key FROM storage_gc WHERE not_before<=now() ORDER BY not_before LIMIT 200",
    )
  ).rows;
  for (const candidate of candidates)
    try {
      await transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "storage:" + candidate.key,
        ]);
        const item = (
          await client.query(
            "SELECT * FROM storage_gc WHERE area=$1 AND key=$2 AND not_before<=now() FOR UPDATE",
            [candidate.area, candidate.key],
          )
        ).rows[0];
        if (!item) return;
        const live =
          item.area === "originals"
            ? (
                await client.query(
                  "SELECT 1 FROM assets WHERE storage_key=$1 LIMIT 1",
                  [item.key],
                )
              ).rowCount
            : item.area === "derived"
              ? (
                  await client.query(
                    "SELECT 1 FROM assets WHERE id=$1 OR metadata->'thumbnail'->>'key'=$2 LIMIT 1",
                    [item.key.split(".")[0],item.key],
                  )
                ).rowCount
              : 0;
        if (!live)
          await fs.rm(storagePath(item.area, item.key), { force: true });
        await client.query("DELETE FROM storage_gc WHERE area=$1 AND key=$2", [
          item.area,
          item.key,
        ]);
      });
    } catch {
      await db.query(
        "UPDATE storage_gc SET attempts=attempts+1,not_before=now()+interval '1 hour' WHERE area=$1 AND key=$2",
        [candidate.area, candidate.key],
      );
      console.error("Deferred resource cleanup will retry");
    }
}
export async function expireTrash(documents?: Documents) {
  for (const kind of ["teams", "spaces", "documents"] as const) {
    const rows = (
      await db.query(
        `SELECT id FROM ${kind} WHERE deleted_at<=now()-interval '30 days' ORDER BY deleted_at LIMIT 100`,
      )
    ).rows;
    for (const row of rows)
      try {
        const result = await purgeTrash(kind, row.id, { automatic: true });
        for (const id of result?.noteIds || []) documents?.disconnect(id);
      } catch {
        console.error("Expired trash cleanup will retry");
      }
  }
  await collectStorage();
}
export function startTrashMaintenance(documents: Documents) {
  let task: Promise<void> | undefined;
  const tick = () => {
    if (!task)
      task = expireTrash(documents)
        .catch(() => console.error("Trash maintenance will retry"))
        .finally(() => {
          task = undefined;
        });
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await task;
  };
}

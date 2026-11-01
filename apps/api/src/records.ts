import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Module,
} from "@nestjs/common";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { db } from "./database.js";
import { user, spaceRole, type User } from "./auth.js";
import { identifier, fail, text, optionalText } from "./errors.js";
type Kind = "experiments" | "meetings";
const table = (kind: Kind) =>
  kind === "experiments" ? "experiments" : "meetings";
const view = (row: any) => ({ ...row, revision: Number(row.revision) });
function strings(value: any, label: string, max = 100) {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((v) => typeof v !== "string" || !v.trim() || v.length > 80)
  )
    fail(400, label + "无效");
  return [...new Set<string>(value.map((v) => v.trim()))];
}
function object(value: any, label: string) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 65536
  )
    fail(400, label + "必须是 JSON 对象且不超过 64 KiB");
  return value;
}
const statuses = {
  experiments: ["planned", "running", "complete", "failed"],
  meetings: ["planned", "held", "cancelled"],
};
async function record(account: User, kind: Kind, id: string, edit = false) {
  const row = (
    await db.query(`SELECT * FROM ${table(kind)} WHERE id=$1`, [identifier(id)])
  ).rows[0];
  if (!row) fail(404, "记录不存在");
  await spaceRole(account, row.space_id, edit ? "edit" : "read");
  return row;
}
async function validateReferences(account: User, space: string, input: any) {
  if (input.document_id) {
    const doc = (
      await db.query("SELECT space_id FROM documents WHERE id=$1", [
        identifier(input.document_id),
      ])
    ).rows[0];
    if (!doc || doc.space_id !== space) fail(400, "关联笔记必须属于当前知识库");
  }
  if (input.asset_ids.length) {
    const rows = (
      await db.query(
        "SELECT id FROM assets WHERE space_id=$1 AND id=ANY($2::text[])",
        [space, input.asset_ids],
      )
    ).rows;
    if (rows.length !== input.asset_ids.length)
      fail(400, "关联资源必须属于当前知识库");
  }
}
async function normalized(
  account: User,
  kind: Kind,
  space: string,
  input: any,
  current: any = {},
) {
  const value = { ...current, ...input },
    result: any = {
      title: text(value.title, "标题", 200),
      status: value.status || "planned",
      archived: value.archived ?? false,
      document_id: value.document_id ? identifier(value.document_id) : null,
    };
  if (
    !statuses[kind].includes(result.status) ||
    typeof result.archived !== "boolean"
  )
    fail(400, "状态无效");
  if (kind === "experiments") {
    Object.assign(result, {
      model: optionalText(value.model, 300),
      dataset: optionalText(value.dataset, 300),
      environment: optionalText(value.environment, 12000),
      parameters: object(value.parameters ?? {}, "参数"),
      metrics: object(value.metrics ?? {}, "指标"),
      tags: strings(value.tags ?? [], "标签", 30),
      input_asset_ids: strings(value.input_asset_ids ?? [], "输入资源"),
      output_asset_ids: strings(value.output_asset_ids ?? [], "输出资源"),
    });
    if (
      Object.keys(result.metrics).length > 100 ||
      Object.values(result.metrics).some(
        (v) =>
          !["string", "number"].includes(typeof v) ||
          (typeof v === "string" && v.length > 200),
      )
    )
      fail(400, "指标应为最多 100 个名称与数值／文本的映射");
    result.asset_ids = [
      ...new Set<string>([
        ...result.input_asset_ids,
        ...result.output_asset_ids,
      ]),
    ];
  } else {
    const starts =
      input.starts_at === undefined && current.starts_at instanceof Date
        ? current.starts_at.toISOString()
        : value.starts_at;
    const date = new Date(starts);
    if (typeof starts !== "string" || Number.isNaN(date.getTime()))
      fail(400, "会议时间无效");
    result.starts_at = date.toISOString();
    result.agenda = optionalText(value.agenda, 30000);
    result.asset_ids = strings(value.asset_ids ?? [], "会议材料");
    if (
      !Array.isArray(value.actions ?? []) ||
      (value.actions ?? []).length > 100
    )
      fail(400, "行动项无效");
    const members = (
      await db.query("SELECT user_id FROM space_members WHERE space_id=$1", [
        space,
      ])
    ).rows.map((v) => v.user_id);
    result.actions = (value.actions ?? []).map((action: any) => {
      const id = action.id ? identifier(action.id) : randomUUID(),
        title = text(action.title, "行动项", 500),
        assignee = action.assignee ? identifier(action.assignee) : null,
        due = action.due || null,
        done = action.done ?? false;
      if (assignee && !members.includes(assignee))
        fail(400, "行动项负责人必须是知识库成员");
      if (
        due &&
        (typeof due !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(due) ||
          !Number.isFinite(Date.parse(due)) ||
          new Date(due).toISOString().slice(0, 10) !== due)
      )
        fail(400, "行动项截止日期无效");
      if (typeof done !== "boolean") fail(400, "行动项完成状态无效");
      return { id, title, assignee, due, done };
    });
    if (
      new Set(result.actions.map((v: any) => v.id)).size !==
      result.actions.length
    )
      fail(400, "行动项 ID 重复");
  }
  await validateReferences(account, space, result);
  return result;
}
async function list(
  account: User,
  kind: Kind,
  space: string,
  q: string,
  archived: string,
) {
  identifier(space);
  await spaceRole(account, space);
  const extra =
    kind === "experiments"
      ? " OR model ILIKE '%'||$3||'%' OR dataset ILIKE '%'||$3||'%' OR array_to_string(tags,' ') ILIKE '%'||$3||'%'"
      : " OR agenda ILIKE '%'||$3||'%' OR actions::text ILIKE '%'||$3||'%'";
  return (
    await db.query(
      `SELECT * FROM ${table(kind)} WHERE space_id=$1 AND archived=$2 AND ($3='' OR title ILIKE '%'||$3||'%' ${extra}) ORDER BY ${kind === "meetings" ? "starts_at" : "updated_at"} DESC LIMIT 500`,
      [space, archived === "true", optionalText(q, 200)],
    )
  ).rows.map(view);
}
async function save(account: User, kind: Kind, input: any, id?: string) {
  const current = id ? await record(account, kind, id, true) : null,
    space = current?.space_id || identifier(input?.space_id);
  await spaceRole(account, space, "edit");
  if (current && !Number.isSafeInteger(input?.revision))
    fail(400, "请提供记录版本");
  const value = await normalized(account, kind, space, input, current || {}),
    keys = Object.keys(value),
    values = keys.map((key) =>
      ["parameters", "metrics", "actions"].includes(key)
        ? JSON.stringify(value[key])
        : value[key],
    );
  let row;
  if (current) {
    row = (
      await db.query(
        `UPDATE ${table(kind)} SET ${keys.map((key, i) => `${key}=$${i + 1}`).join(",")},revision=revision+1,updated_at=now() WHERE id=$${keys.length + 1} AND revision=$${keys.length + 2} RETURNING *`,
        [...values, id, input.revision],
      )
    ).rows[0];
    if (!row) fail(409, "记录已被其他成员修改，请保留草稿并刷新后重试");
  } else
    row = (
      await db.query(
        `INSERT INTO ${table(kind)} (${keys.join(",")},id,space_id,created_by) VALUES(${[...keys, "id", "space_id", "created_by"].map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`,
        [...values, randomUUID(), space, account.id],
      )
    ).rows[0];
  return view(row);
}
@Controller("api")
export class RecordsController {
  @Get("experiments") async experiments(
    @Req() req: Request,
    @Query("space_id") space: string,
    @Query("q") q = "",
    @Query("archived") archived = "false",
  ) {
    return list(await user(req), "experiments", space, q, archived);
  }
  @Get("experiments/:id") async experiment(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return view(await record(await user(req), "experiments", id));
  }
  @Post("experiments") async createExperiment(
    @Req() req: Request,
    @Body() input: any,
  ) {
    return save(await user(req), "experiments", input);
  }
  @Patch("experiments/:id") async updateExperiment(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return save(await user(req), "experiments", input, identifier(id));
  }
  @Get("meetings") async meetings(
    @Req() req: Request,
    @Query("space_id") space: string,
    @Query("q") q = "",
    @Query("archived") archived = "false",
  ) {
    return list(await user(req), "meetings", space, q, archived);
  }
  @Get("meetings/:id") async meeting(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return view(await record(await user(req), "meetings", id));
  }
  @Post("meetings") async createMeeting(
    @Req() req: Request,
    @Body() input: any,
  ) {
    return save(await user(req), "meetings", input);
  }
  @Patch("meetings/:id") async updateMeeting(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return save(await user(req), "meetings", input, identifier(id));
  }
}
@Module({ controllers: [RecordsController] })
export class RecordsModule {}

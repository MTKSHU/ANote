import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import fs from "node:fs/promises";
const origin = process.env.BASE_URL || "http://anote.internal:3000",
  proof = "artifacts/server/records-proof.json";
let admin,
  editor,
  viewer,
  outsider,
  space,
  otherSpace,
  note,
  asset,
  experiment,
  meeting;
async function api(
  endpoint,
  method = "GET",
  body,
  account = editor,
  status = 200,
) {
  const response = await fetch(origin + "/api/" + endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(account ? { Authorization: "Bearer " + account.token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, status, method + " " + endpoint);
  return response.json();
}
if (process.env.RECORD_PHASE === "restart") {
  test("会议行动项、实验指标、资源及笔记关联在容器和数据库重启后保留", async () => {
    ({ editor, experiment, meeting, note, asset } = JSON.parse(
      await fs.readFile(proof, "utf8"),
    ));
    const e = await api("experiments/" + experiment.id),
      m = await api("meetings/" + meeting.id);
    assert.deepEqual(e.metrics, experiment.metrics);
    assert.deepEqual(e.input_asset_ids, [asset.id]);
    assert.equal(e.document_id, note.id);
    assert.equal(m.actions[0].done, true);
    assert.equal(m.actions[0].assignee, editor.user.id);
    assert.equal(m.starts_at, "2026-10-30T06:00:00.000Z");
    assert.equal(m.document_id, note.id);
  });
} else {
  test("实验和会议遵循真实成员权限，拒绝跨知识库资源与笔记关联", async () => {
    admin = await api(
      "auth/login",
      "POST",
      {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD,
      },
      null,
      201,
    );
    space = (
      await api(
        "spaces",
        "POST",
        { name: "团队记录 " + randomUUID().slice(0, 6) },
        admin,
        201,
      )
    ).id;
    otherSpace = (
      await api(
        "spaces",
        "POST",
        { name: "记录隔离 " + randomUUID().slice(0, 6) },
        admin,
        201,
      )
    ).id;
    const accounts = [];
    for (const role of ["editor", "viewer", "outsider"]) {
      const username = role + "-" + randomUUID().slice(0, 8),
        password = randomBytes(16).toString("hex"),
        created = await api(
          "users",
          "POST",
          { username, password, name: role },
          admin,
          201,
        );
      const account = await api(
        "auth/login",
        "POST",
        { username, password },
        null,
        201,
      );
      accounts.push(account);
      if (role !== "outsider")
        await api(
          `spaces/${space}/members`,
          "POST",
          { user_id: created.id, role },
          admin,
          201,
        );
    }
    [editor, viewer, outsider] = accounts;
    note = await api(
      "documents",
      "POST",
      { space_id: space, title: "实验及会议协作笔记",visibility:"team" },
      editor,
      201,
    );
    const foreign = await api(
      "documents",
      "POST",
      { space_id: otherSpace, title: "其他知识库笔记" },
      admin,
      201,
    );
    const bytes = Buffer.from("research-input"),
      hash = createHash("sha256").update(bytes).digest("hex"),
      upload = await api(
        "uploads",
        "POST",
        { space_id: space, filename: "input.txt", bytes: bytes.length, hash },
        editor,
        201,
      );
    const response = await fetch(origin + `/api/uploads/${upload.id}/chunk`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + editor.token,
        "Content-Type": "application/octet-stream",
        "Upload-Offset": "0",
        "X-Chunk-SHA256": hash,
      },
      body: bytes,
    });
    assert.equal(response.status, 200);
    asset = await api(`uploads/${upload.id}/complete`, "POST", {}, editor, 201);
    await api(
      "experiments",
      "POST",
      { space_id: space, title: "跨库", document_id: foreign.id },
      editor,
      400,
    );
    await api(
      "experiments",
      "POST",
      { space_id: otherSpace, title: "越权" },
      editor,
      403,
    );
    await api(
      "experiments",
      "POST",
      { space_id: space, title: "只读写入" },
      viewer,
      403,
    );
    await api(`meetings?space_id=${space}`, "GET", undefined, outsider, 403);
    await api(
      "meetings",
      "POST",
      { space_id: space, title: "无效时间", starts_at: "not-a-date" },
      editor,
      400,
    );
  });
  test("实验结构化指标、输入输出可检索，过期资料更新报告冲突", async () => {
    experiment = await api(
      "experiments",
      "POST",
      {
        space_id: space,
        title: "高斯基线",
        status: "complete",
        model: "3DGS",
        dataset: "Courtyard",
        parameters: { steps: 30000, seed: 42 },
        environment: "CUDA / Docker",
        metrics: { PSNR: 28.5, SSIM: 0.91 },
        input_asset_ids: [asset.id],
        output_asset_ids: [asset.id],
        tags: ["基线"],
        document_id: note.id,
      },
      editor,
      201,
    );
    assert.deepEqual(experiment.asset_ids, [asset.id]);
    assert.equal(experiment.revision, 1);
    assert.equal(
      (
        await api(
          `experiments?space_id=${space}&q=Courtyard`,
          "GET",
          undefined,
          viewer,
        )
      )[0].id,
      experiment.id,
    );
    await api(
      "experiments/" + experiment.id,
      "PATCH",
      { revision: 1, metrics: { PSNR: [28] } },
      editor,
      400,
    );
    const changed = await api("experiments/" + experiment.id, "PATCH", {
      revision: 1,
      metrics: { PSNR: 29.25, SSIM: 0.93 },
    });
    await api(
      "experiments/" + experiment.id,
      "PATCH",
      { revision: 1, title: "过期资料" },
      editor,
      409,
    );
    await api(
      "experiments/" + experiment.id,
      "PATCH",
      { revision: 2, title: "只读修改" },
      viewer,
      403,
    );
    assert.equal((await api("experiments/" + experiment.id)).title, "高斯基线");
    const archived = await api("experiments/" + experiment.id, "PATCH", {
      revision: changed.revision,
      archived: true,
    });
    assert.equal((await api(`experiments?space_id=${space}`)).length, 0);
    assert.equal(
      (await api(`experiments?space_id=${space}&archived=true`)).length,
      1,
    );
    experiment = await api("experiments/" + experiment.id, "PATCH", {
      revision: archived.revision,
      archived: false,
    });
  });
  test("会议材料、纪要、负责人和截止日保存，行动项并发更新及归档恢复", async () => {
    const value = {
      space_id: space,
      title: "每周研究分享",
      starts_at: "2026-10-30T14:00:00+08:00",
      agenda: "讨论高斯重建与本周实验",
      document_id: note.id,
      asset_ids: [asset.id],
      actions: [
        {
          id: randomUUID(),
          title: "补充消融实验",
          assignee: editor.user.id,
          due: "2026-11-02",
          done: false,
        },
      ],
    };
    await api(
      "meetings",
      "POST",
      {
        ...value,
        actions: [{ title: "非法负责人", assignee: outsider.user.id }],
      },
      editor,
      400,
    );
    await api(
      "meetings",
      "POST",
      { ...value, actions: [{ title: "非法日期", due: "2026-02-30" }] },
      editor,
      400,
    );
    meeting = await api("meetings", "POST", value, editor, 201);
    assert.equal(meeting.starts_at, "2026-10-30T06:00:00.000Z");
    const changed = await api("meetings/" + meeting.id, "PATCH", {
      revision: 1,
      actions: [{ ...meeting.actions[0], done: true }],
    });
    await api(
      "meetings/" + meeting.id,
      "PATCH",
      { revision: 1, agenda: "过期覆盖" },
      editor,
      409,
    );
    assert.equal(
      (
        await api(
          `meetings?space_id=${space}&q=${encodeURIComponent("消融")}`,
          "GET",
          undefined,
          viewer,
        )
      )[0].actions[0].done,
      true,
    );
    const archived = await api("meetings/" + meeting.id, "PATCH", {
      revision: changed.revision,
      archived: true,
    });
    assert.equal((await api(`meetings?space_id=${space}`)).length, 0);
    meeting = await api("meetings/" + meeting.id, "PATCH", {
      revision: archived.revision,
      archived: false,
      status: "held",
    });
    await fs.writeFile(
      proof,
      JSON.stringify({ editor, experiment, meeting, note, asset }),
      { mode: 0o600 },
    );
  });
}

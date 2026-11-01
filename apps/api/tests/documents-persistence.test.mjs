import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
test("正文、评论线程、审核快照、版本与会话在应用及 PostgreSQL 重启后保留", async () => {
  const proof = JSON.parse(
      await fs.readFile("artifacts/server/documents-proof.json", "utf8"),
    ),
    origin = process.env.BASE_URL || "http://anote.internal:3000";
  async function get(endpoint) {
    const response = await fetch(origin + "/api/" + endpoint, {
      headers: { Authorization: "Bearer " + proof.session.token },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.deepEqual(
    (await get(`documents/${proof.id}`)).snapshot,
    proof.snapshot,
  );
  const comments = await get(`documents/${proof.id}/comments`);
  assert.equal(comments.length, 2);
  assert.equal(
    comments.filter((c) => !c.parent_id)[0].resolvedAnchor.orphaned,
    true,
  );
  const reviews = await get(`documents/${proof.id}/reviews`);
  assert.equal(reviews[0].status, "approved");
  assert.equal(reviews[0].hash, proof.reviewHash);
  assert.equal((await get(`documents/${proof.id}/versions`)).length >= 3, true);
});

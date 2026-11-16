import { test } from "node:test";
import assert from "node:assert/strict";
import { UpdateChecks } from "../../apps/desktop/main/update-checks.mjs";

function setup() {
  const state = { time: 0, calls: 0, key: "signed-out", error: false };
  const snapshot = () => ({ status: state.error ? "error" : "available" });
  const scheduler = new UpdateChecks({ now: () => state.time, contextKey: () => state.key, snapshot,
    check: async () => { state.calls++; if (state.error) throw new Error("network unavailable"); return snapshot(); } });
  return { state, scheduler };
}

test("signed-out startup checks immediately and successful discovery repeats every five minutes", async () => {
  const { state, scheduler } = setup();
  await scheduler.run(); assert.equal(state.calls, 1);
  state.time = 299_999; await scheduler.run(); assert.equal(state.calls, 1);
  state.time = 300_000; await scheduler.run(); assert.equal(state.calls, 2);
});

test("failed startup discovery retries after 30 seconds rather than waiting for the success interval", async () => {
  const { state, scheduler } = setup(); state.error = true;
  await assert.rejects(scheduler.run(), /network unavailable/);
  state.time = 29_999; await scheduler.run(); assert.equal(state.calls, 1);
  state.error = false; state.time = 30_000;
  assert.equal((await scheduler.run()).status, "available"); assert.equal(state.calls, 2);
  state.time += 30_000; await scheduler.run(); assert.equal(state.calls, 2);
});

test("focus and connectivity events refresh early with a 30 second storm guard", async () => {
  const { state, scheduler } = setup(); await scheduler.run();
  state.time = 10_000; await scheduler.run({ event: true }); assert.equal(state.calls, 1);
  state.time = 30_000; await scheduler.run({ event: true }); assert.equal(state.calls, 2);
  await scheduler.run({ event: true }); assert.equal(state.calls, 2);
});

test("manual checks and a changed server/login bypass the automatic cooldown", async () => {
  const { state, scheduler } = setup(); await scheduler.run();
  await scheduler.run({ force: true }); assert.equal(state.calls, 2);
  state.key = "authenticated"; await scheduler.run(); assert.equal(state.calls, 3);
  state.key = "other-server"; await scheduler.run(); assert.equal(state.calls, 4);
});

test("overlapping startup, manual and online checks share one request", async () => {
  let finish, calls = 0;
  const scheduler = new UpdateChecks({ now: () => 0, contextKey: () => "same", snapshot: () => ({}), check: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } });
  const first = scheduler.run(), manual = scheduler.run({ force: true }), online = scheduler.run({ event: true });
  assert.equal(first, manual); assert.equal(first, online);
  await Promise.resolve(); assert.equal(calls, 1);
  finish({ status: "available" });
  assert.deepEqual(await first, { status: "available" });
});

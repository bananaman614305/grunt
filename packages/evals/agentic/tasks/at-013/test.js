"use strict";
const assert = require("node:assert");
const { createPool } = require("./pool.js");

let failed = 0;
const checks = [];
function check(name, fn) {
  checks.push(async () => {
    try { await fn(); console.log("ok - " + name); }
    catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
  });
}

function deferred() {
  const box = {};
  box.promise = new Promise((resolve, reject) => { box.resolve = resolve; box.reject = reject; });
  return box;
}
// Let every already-settled promise run its callbacks before we look again.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

check("a failing job releases its slot and later jobs still run in order", async () => {
  const pool = createPool(2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started = [];
  const settled = [];
  for (let i = 0; i < 4; i += 1) {
    pool
      .run(() => { started.push(i); return gates[i].promise; })
      .then((value) => settled.push("ok:" + i + ":" + value), (err) => settled.push("err:" + i + ":" + err.message));
  }
  await flush();
  assert.deepStrictEqual(started, [0, 1], "only `limit` jobs may start");

  gates[0].reject(new Error("boom"));
  await flush();
  assert.deepStrictEqual(settled, ["err:0:boom"], "the caller sees the failure");
  assert.deepStrictEqual(started, [0, 1, 2], "the failed job's slot is reused");

  gates[1].resolve("b");
  await flush();
  assert.deepStrictEqual(started, [0, 1, 2, 3]);
  gates[2].resolve("c");
  await flush();
  gates[3].resolve("d");
  await flush();
  assert.deepStrictEqual(settled, ["err:0:boom", "ok:1:b", "ok:2:c", "ok:3:d"]);
});

check("a job that throws before returning a promise rejects its caller", async () => {
  const pool = createPool(1);
  let after = null;
  const first = pool.run(() => { throw new Error("sync"); });
  const second = pool.run(() => Promise.resolve("next"));
  await first.then(() => { throw new Error("expected a rejection"); }, (err) => {
    assert.strictEqual(err.message, "sync");
  });
  after = await second;
  assert.strictEqual(after, "next");
});

check("onIdle waits for running and newly queued work", async () => {
  const pool = createPool(1);
  const first = deferred();
  const second = deferred();
  pool.run(() => first.promise);
  let idle = false;
  pool.onIdle().then(() => { idle = true; });
  await flush();
  assert.strictEqual(idle, false, "not idle while a job is running");

  pool.run(() => second.promise).catch(() => {});
  first.resolve(1);
  await flush();
  assert.strictEqual(idle, false, "not idle while the job queued behind it runs");

  second.reject(new Error("late"));
  await flush();
  assert.strictEqual(idle, true, "idle once everything has settled");
});

check("onIdle on a pool with nothing to do resolves", async () => {
  const pool = createPool(2);
  let idle = false;
  pool.onIdle().then(() => { idle = true; });
  await flush();
  assert.strictEqual(idle, true);
});

async function main() {
  for (const run of checks) await run();
  process.exit(failed === 0 ? 0 : 1);
}
main();

"use strict";
const assert = require("node:assert");
const { summarize } = require("./aggregate.js");
const { createSummary } = require("./incremental.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const GROUPS = ["north", "south", "east", "west"];
// A tiny deterministic generator, so every run walks the same sequence.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

check("an empty summary matches an empty recompute", () => {
  assert.deepStrictEqual(createSummary().snapshot(), summarize([]));
});

check("the snapshot matches a full recompute after every change", () => {
  const next = random(42);
  const summary = createSummary();
  const held = [];
  for (let step = 0; step < 600; step += 1) {
    if (held.length > 0 && next() < 0.4) {
      const [row] = held.splice(Math.floor(next() * held.length), 1);
      summary.remove(row);
    } else {
      // A narrow range of amounts, so equal minima and maxima are common.
      const row = {
        id: "r" + step,
        group: GROUPS[Math.floor(next() * GROUPS.length)],
        amount: Math.floor(next() * 40) - 20,
      };
      held.push(row);
      summary.add(row);
    }
    assert.deepStrictEqual(summary.snapshot(), summarize(held), "after step " + step);
  }
  while (held.length > 0) summary.remove(held.pop());
  assert.deepStrictEqual(summary.snapshot(), summarize([]), "after draining every row");
});

check("a group comes back after its last row leaves", () => {
  const summary = createSummary();
  const row = { id: "a", group: "north", amount: 5 };
  summary.add(row);
  summary.add({ id: "b", group: "south", amount: 1 });
  summary.remove(row);
  assert.deepStrictEqual(summary.snapshot(), summarize([{ id: "b", group: "south", amount: 1 }]));
  summary.add({ id: "c", group: "north", amount: 9 });
  assert.deepStrictEqual(
    summary.snapshot(),
    summarize([{ id: "b", group: "south", amount: 1 }, { id: "c", group: "north", amount: 9 }]),
  );
});

check("unknown and duplicate rows are rejected", () => {
  const summary = createSummary();
  summary.add({ id: "a", group: "north", amount: 5 });
  assert.throws(() => summary.add({ id: "a", group: "south", amount: 1 }), {
    message: "duplicate row: a",
  });
  assert.throws(() => summary.remove({ id: "zz", group: "north", amount: 5 }), {
    message: "unknown row: zz",
  });
  assert.deepStrictEqual(summary.snapshot(), summarize([{ id: "a", group: "north", amount: 5 }]));
});

check("snapshots are independent of each other", () => {
  const summary = createSummary();
  const rows = [
    { id: "a", group: "north", amount: 5 },
    { id: "b", group: "south", amount: 1 },
  ];
  for (const row of rows) summary.add(row);
  const first = summary.snapshot();
  first.groups.north.sum = 999;
  first.groups.north.min = 999;
  delete first.groups.south;
  first.total.count = -1;
  assert.deepStrictEqual(summary.snapshot(), summarize(rows));
});

check("it keeps up over tens of thousands of changes", () => {
  const next = random(7);
  const summary = createSummary();
  const held = [];
  const startedAt = Date.now();
  for (let i = 0; i < 40000; i += 1) {
    const row = { id: "s" + i, group: GROUPS[i % GROUPS.length], amount: Math.floor(next() * 1000) };
    held.push(row);
    summary.add(row);
    summary.snapshot();
  }
  let cursor = 0;
  for (; cursor < 30000; cursor += 1) {
    summary.remove(held[cursor]);
    summary.snapshot();
  }
  const elapsed = Date.now() - startedAt;
  assert.deepStrictEqual(summary.snapshot(), summarize(held.slice(cursor)));
  assert.ok(elapsed < 10000, "70000 changes took " + elapsed + "ms, which is too slow");
});

process.exit(failed === 0 ? 0 : 1);

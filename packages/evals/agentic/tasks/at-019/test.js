"use strict";
const assert = require("node:assert");
const { matches } = require("./cron.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

// Every date is UTC. 2026-02-13 is a Friday, 2026-06-05 a Friday,
// 2026-06-13 a Saturday, 2026-06-07 a Sunday, 2026-01-01 a Thursday.
const at = (y, m, d, h = 0, min = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, min, s));
const on = (expression, date) => matches(expression, date);

check("stars match anything and single values pin a field", () => {
  assert.strictEqual(on("* * * * *", at(2026, 6, 5, 13, 37)), true);
  assert.strictEqual(on("30 4 * * *", at(2026, 6, 5, 4, 30)), true);
  assert.strictEqual(on("30 4 * * *", at(2026, 6, 5, 4, 31)), false);
  assert.strictEqual(on("30 4 * * *", at(2026, 6, 5, 5, 30)), false);
});

check("seconds are ignored and fields are read in UTC", () => {
  assert.strictEqual(on("30 4 * * *", at(2026, 6, 5, 4, 30, 45)), true);
});

check("lists and ranges", () => {
  assert.strictEqual(on("0,30 * * * *", at(2026, 6, 5, 1, 30)), true);
  assert.strictEqual(on("0,30 * * * *", at(2026, 6, 5, 1, 15)), false);
  assert.strictEqual(on("0 9-17 * * *", at(2026, 6, 5, 9)), true);
  assert.strictEqual(on("0 9-17 * * *", at(2026, 6, 5, 17)), true);
  assert.strictEqual(on("0 9-17 * * *", at(2026, 6, 5, 18)), false);
});

check("steps", () => {
  assert.strictEqual(on("*/15 * * * *", at(2026, 6, 5, 1, 45)), true);
  assert.strictEqual(on("*/15 * * * *", at(2026, 6, 5, 1, 20)), false);
  assert.strictEqual(on("0 0-12/6 * * *", at(2026, 6, 5, 12)), true);
  assert.strictEqual(on("0 0-12/6 * * *", at(2026, 6, 5, 18)), false);
  assert.strictEqual(on("0 9/6 * * *", at(2026, 6, 5, 21)), true);
  assert.strictEqual(on("0 9/6 * * *", at(2026, 6, 5, 3)), false);
});

check("names for months and days of the week", () => {
  assert.strictEqual(on("0 0 1 JAN *", at(2026, 1, 1)), true);
  assert.strictEqual(on("0 0 1 jan *", at(2026, 2, 1)), false);
  assert.strictEqual(on("0 0 * * MON-FRI", at(2026, 1, 1)), true);
  assert.strictEqual(on("0 0 * * mon-fri", at(2026, 2, 1)), false);
  assert.strictEqual(on("0 0 * * 7", at(2026, 6, 7)), true);
  assert.strictEqual(on("0 0 * * 7", at(2026, 6, 5)), false);
});

check("one restricted day field decides on its own", () => {
  assert.strictEqual(on("0 0 13 * *", at(2026, 6, 13)), true);
  assert.strictEqual(on("0 0 13 * *", at(2026, 6, 5)), false);
  assert.strictEqual(on("0 0 * * FRI", at(2026, 6, 5)), true);
  assert.strictEqual(on("0 0 * * FRI", at(2026, 6, 13)), false);
});

check("two restricted day fields match on either", () => {
  assert.strictEqual(on("0 0 13 * FRI", at(2026, 2, 13)), true, "Friday the 13th");
  assert.strictEqual(on("0 0 13 * FRI", at(2026, 6, 13)), true, "the 13th, a Saturday");
  assert.strictEqual(on("0 0 13 * FRI", at(2026, 6, 5)), true, "a Friday, not the 13th");
  assert.strictEqual(on("0 0 13 * FRI", at(2026, 6, 6)), false, "neither");
});

check("invalid expressions throw with the expression quoted", () => {
  const bad = (expression) =>
    assert.throws(() => matches(expression, at(2026, 6, 5)), {
      message: "invalid cron expression: " + expression,
    }, expression);
  bad("* * * *");
  bad("* * * * * *");
  bad("60 * * * *");
  bad("* * * 13 *");
  bad("* * 0 * *");
  bad("*/0 * * * *");
  bad("a * * * *");
  bad("0 0 * * FUN");
});

process.exit(failed === 0 ? 0 : 1);

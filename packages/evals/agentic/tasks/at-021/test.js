"use strict";
const assert = require("node:assert");
const { nightsBetween, blockedDays } = require("./stay.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("nights are the gaps between the days", () => {
  assert.strictEqual(nightsBetween(2, 5), 3);
  assert.strictEqual(nightsBetween(0, 1), 1);
  assert.strictEqual(nightsBetween(10, 17), 7);
});

check("a block reserves every day from end to end", () => {
  assert.deepStrictEqual(blockedDays(2, 5), [2, 3, 4, 5]);
  assert.deepStrictEqual(blockedDays(3, 3), [3]);
  assert.deepStrictEqual(blockedDays(0, 2), [0, 1, 2]);
});

process.exit(failed === 0 ? 0 : 1);

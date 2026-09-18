"use strict";
const assert = require("node:assert");
const { median } = require("./stats.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("odd-length list", () => {
  assert.strictEqual(median([9, 10, 2]), 9);
});
check("even-length list averages the two middle values", () => {
  assert.strictEqual(median([10, 2, 33, 4]), 7);
});
check("does not modify the input", () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepStrictEqual(input, [3, 1, 2]);
});

process.exit(failed === 0 ? 0 : 1);

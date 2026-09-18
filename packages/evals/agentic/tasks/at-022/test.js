"use strict";
const assert = require("node:assert");
const { boxesNeeded, fullBoxes } = require("./packing.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("boxesNeeded counts a partial box too", () => {
  assert.strictEqual(boxesNeeded(10, 4), 3);
  assert.strictEqual(boxesNeeded(1, 4), 1);
  assert.strictEqual(boxesNeeded(8, 4), 2);
  assert.strictEqual(boxesNeeded(0, 4), 0);
});

check("fullBoxes counts only the boxes that fill up", () => {
  assert.strictEqual(fullBoxes(10, 4), 2);
  assert.strictEqual(fullBoxes(8, 4), 2);
  assert.strictEqual(fullBoxes(3, 4), 0);
  assert.strictEqual(fullBoxes(0, 4), 0);
});

process.exit(failed === 0 ? 0 : 1);

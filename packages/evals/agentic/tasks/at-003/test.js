"use strict";
const assert = require("node:assert");
const { paginate } = require("./paginate.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const items = ["a", "b", "c", "d", "e"];

check("page 1 starts at the first item", () => {
  assert.deepStrictEqual(paginate(items, 1, 2).items, ["a", "b"]);
});
check("last page holds the remainder", () => {
  assert.deepStrictEqual(paginate(items, 3, 2).items, ["e"]);
});
check("totalPages rounds up", () => {
  assert.strictEqual(paginate(items, 1, 2).totalPages, 3);
});

process.exit(failed === 0 ? 0 : 1);

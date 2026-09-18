"use strict";
const assert = require("node:assert");
const { Stack } = require("./stack.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("peek returns the top without removing it", () => {
  const s = new Stack().push(1).push(2);
  assert.strictEqual(s.peek(), 2);
  assert.strictEqual(s.size, 2);
});
check("peek on an empty stack throws RangeError", () => {
  assert.throws(() => new Stack().peek(), RangeError);
});
check("isEmpty reflects the contents", () => {
  const s = new Stack();
  assert.strictEqual(s.isEmpty(), true);
  s.push("x");
  assert.strictEqual(s.isEmpty(), false);
});

process.exit(failed === 0 ? 0 : 1);

"use strict";
const assert = require("node:assert");
const { slugify } = require("./slugify.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("joins every word with a hyphen", () => {
  assert.strictEqual(slugify("Milo routes small tasks"), "milo-routes-small-tasks");
});
check("collapses runs of separators", () => {
  assert.strictEqual(slugify("one  --  two"), "one-two");
});
check("drops leading and trailing separators", () => {
  assert.strictEqual(slugify(" Hello, world! "), "hello-world");
});

process.exit(failed === 0 ? 0 : 1);

"use strict";
const assert = require("node:assert");
const { normalize } = require("./normalize.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("an already-simple path is unchanged", () => {
  assert.strictEqual(normalize("/a/b/c"), "/a/b/c");
});

check("dot segments and repeated slashes disappear", () => {
  assert.strictEqual(normalize("/a/./b"), "/a/b");
  assert.strictEqual(normalize("/a//b"), "/a/b");
  assert.strictEqual(normalize("/a/b/"), "/a/b");
});

check("dot-dot drops the segment before it", () => {
  assert.strictEqual(normalize("/a/b/../c"), "/a/c");
  assert.strictEqual(normalize("/a/b/../../c"), "/c");
});

check("dot-dot at the root stays at the root", () => {
  assert.strictEqual(normalize("/../a"), "/a");
  assert.strictEqual(normalize("/a/../../b"), "/b");
});

check("the root normalizes to a single slash", () => {
  assert.strictEqual(normalize("/"), "/");
  assert.strictEqual(normalize("/a/.."), "/");
});

process.exit(failed === 0 ? 0 : 1);

"use strict";
const assert = require("node:assert");
const { titleCase } = require("./title.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("small words in the middle stay lowercase", () => {
  assert.strictEqual(titleCase("the lord of the rings"), "The Lord of the Rings");
});

check("a small word as the first word is capitalized", () => {
  assert.strictEqual(titleCase("of mice and men"), "Of Mice and Men");
});

check("a small word as the last word is capitalized", () => {
  assert.strictEqual(titleCase("what are you in"), "What Are You In");
});

check("first and last both apply on a two-word title", () => {
  assert.strictEqual(titleCase("come to"), "Come To");
});

check("a longer title mixes all the rules", () => {
  assert.strictEqual(titleCase("a tale of two cities"), "A Tale of Two Cities");
});

process.exit(failed === 0 ? 0 : 1);

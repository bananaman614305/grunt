"use strict";
const assert = require("node:assert");
const { ordinal } = require("./ordinal.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("the ones digit picks the suffix", () => {
  assert.strictEqual(ordinal(1), "1st");
  assert.strictEqual(ordinal(2), "2nd");
  assert.strictEqual(ordinal(3), "3rd");
  assert.strictEqual(ordinal(4), "4th");
  assert.strictEqual(ordinal(9), "9th");
});

check("the teens are all 'th'", () => {
  assert.strictEqual(ordinal(11), "11th");
  assert.strictEqual(ordinal(12), "12th");
  assert.strictEqual(ordinal(13), "13th");
});

check("past the teens the ones digit rules again", () => {
  assert.strictEqual(ordinal(21), "21st");
  assert.strictEqual(ordinal(22), "22nd");
  assert.strictEqual(ordinal(23), "23rd");
  assert.strictEqual(ordinal(101), "101st");
});

check("the hundred-teens are 'th' too", () => {
  assert.strictEqual(ordinal(111), "111th");
  assert.strictEqual(ordinal(112), "112th");
  assert.strictEqual(ordinal(113), "113th");
});

process.exit(failed === 0 ? 0 : 1);

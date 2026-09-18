"use strict";
const assert = require("node:assert");
const { pluralize } = require("./pluralize.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("a plain word takes s", () => {
  assert.strictEqual(pluralize("cat"), "cats");
  assert.strictEqual(pluralize("dog"), "dogs");
});

check("sibilant endings take es", () => {
  assert.strictEqual(pluralize("bus"), "buses");
  assert.strictEqual(pluralize("box"), "boxes");
  assert.strictEqual(pluralize("church"), "churches");
  assert.strictEqual(pluralize("dish"), "dishes");
});

check("a consonant before y becomes ies", () => {
  assert.strictEqual(pluralize("baby"), "babies");
  assert.strictEqual(pluralize("city"), "cities");
});

check("a vowel before y just takes s", () => {
  assert.strictEqual(pluralize("boy"), "boys");
  assert.strictEqual(pluralize("day"), "days");
});

process.exit(failed === 0 ? 0 : 1);

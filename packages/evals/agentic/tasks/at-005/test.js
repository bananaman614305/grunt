"use strict";
const assert = require("node:assert");
const { formatDuration } = require("./duration.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("zero", () => assert.strictEqual(formatDuration(0), "0s"));
check("seconds only", () => assert.strictEqual(formatDuration(45), "45s"));
check("minutes and seconds", () => assert.strictEqual(formatDuration(62), "1m 2s"));
check("whole hours omit zero units", () => assert.strictEqual(formatDuration(3600), "1h"));
check("all three units", () => assert.strictEqual(formatDuration(3723), "1h 2m 3s"));

process.exit(failed === 0 ? 0 : 1);

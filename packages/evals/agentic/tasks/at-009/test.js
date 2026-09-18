"use strict";
const assert = require("node:assert");
const { formatMoney, formatCount, formatPercent } = require("./fmt.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("money groups thousands", () => {
  assert.strictEqual(formatMoney(1234567), "$1,234,567");
});
check("negative money keeps its sign", () => {
  assert.strictEqual(formatMoney(-950), "-$950");
});
check("counts group thousands and keep the sign", () => {
  assert.strictEqual(formatCount(-12345), "-12,345");
});
check("percent", () => {
  assert.strictEqual(formatPercent(0.5), "50%");
});
check("negative percent keeps its sign", () => {
  assert.strictEqual(formatPercent(-0.25), "-25%");
});

process.exit(failed === 0 ? 0 : 1);

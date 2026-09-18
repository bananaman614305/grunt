"use strict";
const assert = require("node:assert");
const { running, balance, format } = require("./ledger.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const credit = (cents) => ({ type: "credit", cents });
const debit = (cents) => ({ type: "debit", cents });

check("format renders positive, negative and zero amounts", () => {
  assert.strictEqual(format(150), "$1.50");
  assert.strictEqual(format(-150), "-$1.50");
  assert.strictEqual(format(0), "$0.00");
});

check("a statement that ends below zero shows a negative balance", () => {
  assert.strictEqual(format(balance([credit(100), debit(250)])), "-$1.50");
  assert.strictEqual(format(balance([debit(100)])), "-$1.00");
});

check("a statement that stays positive shows a positive balance", () => {
  assert.strictEqual(format(balance([credit(500), debit(150)])), "$3.50");
  assert.strictEqual(format(balance([credit(100), debit(100)])), "$0.00");
});

check("each running line renders in order", () => {
  assert.deepStrictEqual(running([credit(100), debit(250)]).map(format), ["$1.00", "-$1.50"]);
});

process.exit(failed === 0 ? 0 : 1);

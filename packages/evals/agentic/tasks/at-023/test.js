"use strict";
const assert = require("node:assert");
const { splitAmount } = require("./split.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
function spread(xs) { return Math.max(...xs) - Math.min(...xs); }

const CASES = [
  [100, 3], [101, 3], [1, 3], [10, 4], [9, 3], [7, 7], [0, 4], [99, 4],
];

check("the shares always add back up to the total", () => {
  for (const [total, n] of CASES) {
    const shares = splitAmount(total, n);
    assert.strictEqual(shares.length, n, `${total}/${n} wrong length`);
    assert.strictEqual(sum(shares), total, `${total}/${n} summed to ${sum(shares)}`);
  }
});

check("no two shares differ by more than one cent", () => {
  for (const [total, n] of CASES) {
    const shares = splitAmount(total, n);
    assert.ok(spread(shares) <= 1, `${total}/${n} -> ${JSON.stringify(shares)} spread ${spread(shares)}`);
  }
});

check("an exact division is perfectly equal", () => {
  assert.deepStrictEqual(splitAmount(12, 4), [3, 3, 3, 3]);
  assert.deepStrictEqual(splitAmount(0, 4), [0, 0, 0, 0]);
});

process.exit(failed === 0 ? 0 : 1);

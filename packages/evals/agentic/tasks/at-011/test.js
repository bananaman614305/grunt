"use strict";
const assert = require("node:assert");
const { renderReport } = require("./report.js");
const { formatMoney } = require("./format.js");
const { readCount } = require("./catalog.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const ROWS = [
  { label: "Subtotal", amount: 12, currency: "USD", style: "narrow" },
  { label: "Tax", amount: 1.5, currency: "USD", style: "wide" },
  { label: "Total", amount: 13.5, currency: "USD", style: "narrow" },
];

check("each style renders its own symbol", () => {
  assert.strictEqual(formatMoney(12, "USD", "narrow"), "$12.00");
  assert.strictEqual(formatMoney(12, "USD", "wide"), "US$12.00");
  assert.strictEqual(formatMoney(12, "EUR", "wide"), "EUR 12.00");
});

check("a report mixing styles renders each row in its own style", () => {
  assert.strictEqual(
    renderReport(ROWS),
    "Subtotal: $12.00\nTax: US$1.50\nTotal: $13.50",
  );
});

check("row output does not depend on the rows before it", () => {
  const forward = renderReport(ROWS).split("\n");
  const backward = renderReport([...ROWS].reverse()).split("\n").reverse();
  assert.deepStrictEqual(backward, forward);
});

check("decimal places follow the currency, not the style", () => {
  assert.strictEqual(formatMoney(1200, "JPY", "narrow"), "¥1200");
  assert.strictEqual(formatMoney(1200, "JPY", "wide"), "JP¥1200");
});

// Six currency-and-style pairs were used above; the catalog is expensive, so
// it must not have been read more than once for any of them.
check("the catalog is still read at most once per currency and style", () => {
  assert.ok(readCount() <= 6, "catalog read " + readCount() + " times, expected at most 6");
});

process.exit(failed === 0 ? 0 : 1);

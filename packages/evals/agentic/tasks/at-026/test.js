"use strict";
const assert = require("node:assert");
const { createWarehouse } = require("./warehouse.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("stock reads back what was added under the same spelling", () => {
  const wh = createWarehouse();
  wh.add("apple", 3);
  assert.strictEqual(wh.stock("apple"), 3);
});

check("a SKU is the same item however it is capitalized", () => {
  const wh = createWarehouse();
  wh.add("Widget", 5);
  assert.strictEqual(wh.stock("widget"), 5);
  assert.strictEqual(wh.stock("WIDGET"), 5);
});

check("reserving lowers the stock, whatever the casing", () => {
  const wh = createWarehouse();
  wh.add("widget", 5);
  assert.strictEqual(wh.reserve("Widget", 2), 3);
  assert.strictEqual(wh.stock("WIDGET"), 3);
});

check("reserving more than is on hand throws", () => {
  const wh = createWarehouse();
  wh.add("pear", 1);
  assert.throws(() => wh.reserve("pear", 5), /insufficient stock for pear/);
});

process.exit(failed === 0 ? 0 : 1);

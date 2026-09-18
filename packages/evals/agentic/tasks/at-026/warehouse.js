"use strict";

// A warehouse holds whole-unit counts per SKU. SKUs are case-insensitive:
// "Widget", "widget" and "WIDGET" all name the same item.
//
//   add(sku, qty)     add qty units of a SKU.
//   stock(sku)        how many units of a SKU are on hand (0 if none).
//   reserve(sku, qty) take qty units of a SKU, returning the units left;
//                     throws Error("insufficient stock for <sku>") if there
//                     are fewer than qty on hand.
function createWarehouse() {
  const counts = new Map();

  function add(sku, qty) {
    const key = sku.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + qty);
  }

  function stock(sku) {
    return counts.get(sku) ?? 0;
  }

  function reserve(sku, qty) {
    const have = counts.get(sku) ?? 0;
    if (have < qty) throw new Error("insufficient stock for " + sku);
    counts.set(sku, have - qty);
    return have - qty;
  }

  return { add, stock, reserve };
}

module.exports = { createWarehouse };

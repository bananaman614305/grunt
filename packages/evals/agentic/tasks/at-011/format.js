"use strict";

const { memoize } = require("./memo.js");
const { lookup } = require("./catalog.js");

const load = memoize(lookup);

// formatMoney(amount, code, style) renders an amount in a currency, using the
// symbol the requested style asks for and that currency's decimal places.
function formatMoney(amount, code, style) {
  const { symbol, decimals } = load(code, style);
  return symbol + amount.toFixed(decimals);
}

module.exports = { formatMoney };

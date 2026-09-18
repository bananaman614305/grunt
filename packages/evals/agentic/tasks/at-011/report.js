"use strict";

const { formatMoney } = require("./format.js");

// renderReport(rows) turns rows of { label, amount, currency, style } into one
// "<label>: <money>" line each.
function renderReport(rows) {
  return rows
    .map((row) => row.label + ": " + formatMoney(row.amount, row.currency, row.style))
    .join("\n");
}

module.exports = { renderReport };

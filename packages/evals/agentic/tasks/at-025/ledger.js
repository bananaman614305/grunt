"use strict";

// A ledger of money movements. An entry is { type: "credit" | "debit", cents }
// where `cents` is a positive whole number. A credit adds to the balance, a
// debit subtracts from it.

// running(entries) -> the balance in cents after each entry, starting at zero.
function running(entries) {
  let balance = 0;
  const out = [];
  for (const entry of entries) {
    balance += entry.cents;
    out.push(balance);
  }
  return out;
}

// balance(entries) -> the final balance in cents, or 0 when there are none.
function balance(entries) {
  const r = running(entries);
  return r.length === 0 ? 0 : r[r.length - 1];
}

// format(cents) -> a dollar string. 150 -> "$1.50", -150 -> "-$1.50", 0 ->
// "$0.00". The minus sign, when present, comes before the dollar sign.
function format(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return sign + "$" + (abs / 100).toFixed(2);
}

module.exports = { running, balance, format };

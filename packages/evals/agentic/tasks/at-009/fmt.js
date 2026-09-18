"use strict";

// Human-readable number formatting with thousands separators. Negative
// inputs keep their sign in every formatter.

function formatMoney(amount) {
  let digits = Math.abs(Math.round(amount)).toString();
  let out = "";
  while (digits.length > 3) {
    out = "," + digits.slice(-3) + out;
    digits = digits.slice(0, -3);
  }
  out = digits + out;
  return (amount < 0 ? "-$" : "$") + out;
}

function formatCount(n) {
  let digits = Math.abs(Math.round(n)).toString();
  let out = "";
  while (digits.length > 3) {
    out = "," + digits.slice(-3) + out;
    digits = digits.slice(0, -3);
  }
  out = digits + out;
  return (n < 0 ? "-" : "") + out;
}

function formatPercent(value) {
  let digits = Math.round(Math.abs(value) * 100).toString();
  let out = "";
  while (digits.length > 3) {
    out = "," + digits.slice(-3) + out;
    digits = digits.slice(0, -3);
  }
  out = digits + out;
  return out + "%";
}

module.exports = { formatMoney, formatCount, formatPercent };

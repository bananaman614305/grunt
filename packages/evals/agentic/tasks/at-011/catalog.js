"use strict";

// The currency catalog. Reading it is the expensive part of rendering money,
// so callers are expected to go through the cached loader in format.js.
const CURRENCIES = {
  USD: { narrow: "$", wide: "US$", decimals: 2 },
  EUR: { narrow: "€", wide: "EUR ", decimals: 2 },
  JPY: { narrow: "¥", wide: "JP¥", decimals: 0 },
};

let reads = 0;

// lookup(code, style) -> { symbol, decimals }
function lookup(code, style) {
  reads += 1;
  const entry = CURRENCIES[code];
  if (entry === undefined) throw new Error("unknown currency: " + code);
  const symbol = entry[style];
  if (symbol === undefined) throw new Error("unknown style: " + style);
  return { symbol, decimals: entry.decimals };
}

// How many times the catalog has been read in this process.
function readCount() {
  return reads;
}

module.exports = { lookup, readCount };

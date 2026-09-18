"use strict";

// Median of a list of numbers. The input array must not be modified.
function median(values) {
  if (values.length === 0) throw new RangeError("median of empty list");
  const sorted = values.slice().sort();
  return sorted[Math.floor(sorted.length / 2)];
}

module.exports = { median };

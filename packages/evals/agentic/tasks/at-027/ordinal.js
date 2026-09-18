"use strict";

// ordinal(n) returns a positive whole number with its English ordinal suffix:
// 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 21 -> "21st", and so on.
function ordinal(n) {
  const ones = n % 10;
  const suffix = ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th";
  return String(n) + suffix;
}

module.exports = { ordinal };

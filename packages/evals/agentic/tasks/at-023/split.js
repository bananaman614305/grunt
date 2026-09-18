"use strict";

// splitAmount(totalCents, n) divides a whole number of cents among n
// recipients as evenly as it can, returning an array of n whole-cent shares.
//
// Two things must hold at once: the shares add up to exactly totalCents (no
// cent is created or lost), and the shares are as even as possible, so no two
// of them differ by more than one cent.
function splitAmount(totalCents, n) {
  const share = Math.round(totalCents / n);
  return new Array(n).fill(share);
}

module.exports = { splitAmount };

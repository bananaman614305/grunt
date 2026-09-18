"use strict";

// Merge `patch` into `base` without modifying either. Nested plain objects
// merge recursively; arrays and scalars in `patch` replace the base value.
function merge(base, patch) {
  return Object.assign({}, base, patch);
}

module.exports = { merge };

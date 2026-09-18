"use strict";

// Error codes are handed out in blocks of one hundred, one block per
// subsystem. A subsystem's first error is <block> + 1, its second <block> + 2,
// and every code that exists has its message builder in this table.
const BLOCKS = { core: 1000, size: 1100, audit: 1200, quota: 1300 };

const MESSAGES = {
  1001: () => "no handler configured",
  1101: (size) => `request body too large (${size} bytes)`,
};

function codeFor(subsystem, index) {
  const block = BLOCKS[subsystem];
  if (block === undefined) throw new Error("unknown subsystem: " + subsystem);
  return block + index;
}

function messageFor(code, ...args) {
  const build = MESSAGES[code];
  if (build === undefined) throw new Error("unregistered error code: " + code);
  return build(...args);
}

module.exports = { BLOCKS, MESSAGES, codeFor, messageFor };

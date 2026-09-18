"use strict";

// One message builder per validation error code.
const MESSAGES = {
  required: (field) => `${field} is required`,
  min_length: (field, limit) => `${field} must be at least ${limit} characters`,
};

function messageFor(code, field, limit) {
  const build = MESSAGES[code];
  if (!build) throw new Error(`unknown error code: ${code}`);
  return build(field, limit);
}

module.exports = { messageFor };

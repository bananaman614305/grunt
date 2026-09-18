"use strict";

// Split one CSV row into its fields.
function parseRow(row) {
  return row.split(",");
}

module.exports = { parseRow };

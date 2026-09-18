"use strict";

const { normalize } = require("./tokenize.js");

// search(index, query) -> every posting for a one-word query.
function search(index, query) {
  return index.get(normalize(query).trim()) ?? [];
}

module.exports = { search };

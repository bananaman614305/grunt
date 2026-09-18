"use strict";

// The anchor id for a heading: lowercased, runs of non-alphanumerics become a
// single hyphen, no hyphen at either end.
function makeId(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { makeId };

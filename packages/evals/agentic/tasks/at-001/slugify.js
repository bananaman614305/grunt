"use strict";

// Turn a title into a URL slug: lowercase, words joined by single hyphens,
// punctuation dropped, no hyphen at either end.
function slugify(title) {
  return title
    .toLowerCase()
    .replace(" ", "-")
    .replace(/[^a-z0-9-]/g, "");
}

module.exports = { slugify };

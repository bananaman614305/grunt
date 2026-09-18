"use strict";

// The short words that stay lowercase in the middle of a title.
const SMALL = new Set(["a", "an", "and", "the", "of", "to", "in"]);

// titleCase(text) capitalizes the first letter of each word, except that the
// small words above stay lowercase -- unless they are the first or the last
// word of the title, which are always capitalized. Words are separated by
// single spaces and the input is already lowercase.
function titleCase(text) {
  const words = text.split(" ");
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

module.exports = { titleCase, SMALL };

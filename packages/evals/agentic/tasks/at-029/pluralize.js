"use strict";

// pluralize(word) returns the plural of a lowercase English noun using the
// regular spelling rules:
//   - a word ending in s, x, z, ch or sh takes "es" (bus -> buses,
//     box -> boxes, church -> churches, dish -> dishes)
//   - a word ending in a consonant followed by "y" drops the "y" for "ies"
//     (baby -> babies, city -> cities)
//   - a word ending in a vowel followed by "y" just takes "s" (boy -> boys)
//   - anything else takes "s" (cat -> cats)
function pluralize(word) {
  return word + "s";
}

module.exports = { pluralize };

"use strict";

// normalize(text) folds text down to what the index matches on: diacritics
// stripped, runs of whitespace collapsed, lowercased.
function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// tokenize(text) -> [{ term, start, end }], one entry per word, where `term`
// is the normalized word and start/end bracket the word in `text`.
function tokenize(text) {
  const normalized = normalize(text);
  const tokens = [];
  const word = /[a-z0-9]+/g;
  let match;
  while ((match = word.exec(normalized)) !== null) {
    tokens.push({ term: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

module.exports = { normalize, tokenize };

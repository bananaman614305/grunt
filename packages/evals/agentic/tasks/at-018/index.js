"use strict";

const { tokenize } = require("./tokenize.js");

// buildIndex(docs) over documents of { id, text } -> a Map from term to the
// postings { docId, start, end } that mention it, in document order.
function buildIndex(docs) {
  const index = new Map();
  for (const doc of docs) {
    for (const token of tokenize(doc.text)) {
      const postings = index.get(token.term) ?? [];
      postings.push({ docId: doc.id, start: token.start, end: token.end });
      index.set(token.term, postings);
    }
  }
  return index;
}

module.exports = { buildIndex };

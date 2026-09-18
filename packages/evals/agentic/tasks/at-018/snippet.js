"use strict";

// highlight(text, posting) returns the document with the matched word wrapped
// in square brackets.
function highlight(text, posting) {
  return (
    text.slice(0, posting.start) +
    "[" +
    text.slice(posting.start, posting.end) +
    "]" +
    text.slice(posting.end)
  );
}

module.exports = { highlight };

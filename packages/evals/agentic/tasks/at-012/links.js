"use strict";

const { makeId } = require("./ids.js");

// resolveLinks(text, sections) turns a [[Heading]] cross-reference into a link
// to that heading's section. A reference to a heading the document does not
// have is left alone.
function resolveLinks(text, sections) {
  return text.replace(/\[\[([^\]]+)\]\]/g, (match, title) => {
    const target = sections.find((section) => section.title === title);
    if (target === undefined) return match;
    return '<a href="#' + makeId(target.title) + '">' + title + "</a>";
  });
}

module.exports = { resolveLinks };

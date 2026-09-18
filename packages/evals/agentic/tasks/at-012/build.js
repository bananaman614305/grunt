"use strict";

const { parseSections } = require("./parse.js");
const { makeId } = require("./ids.js");
const { renderToc } = require("./toc.js");
const { resolveLinks } = require("./links.js");

// build(markdown) -> a table of contents followed by every section, each
// heading carrying the anchor its table-of-contents entry points at.
function build(markdown) {
  const sections = parseSections(markdown);
  const blocks = sections.map((section) => {
    const anchor = makeId(section.title);
    const open = "<h" + section.level + ' id="' + anchor + '">';
    const close = "</h" + section.level + ">";
    return open + section.title + close + "\n" + resolveLinks(section.body, sections);
  });
  return [renderToc(sections), ...blocks].join("\n");
}

module.exports = { build };

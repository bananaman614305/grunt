"use strict";

const { makeId } = require("./ids.js");

// renderToc(sections) -> one "- [Title](#anchor)" line per section, indented
// two spaces per heading level below the top.
function renderToc(sections) {
  return sections
    .map((section) => {
      const indent = "  ".repeat(section.level - 1);
      return indent + "- [" + section.title + "](#" + makeId(section.title) + ")";
    })
    .join("\n");
}

module.exports = { renderToc };

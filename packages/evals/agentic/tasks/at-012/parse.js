"use strict";

// parseSections(markdown) -> [{ level, title, body }] in document order. A
// heading line ("## Title") starts a section; every line up to the next
// heading is that section's body.
function parseSections(markdown) {
  const sections = [];
  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      sections.push({ level: heading[1].length, title: heading[2].trim(), lines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections.map((section) => ({
    level: section.level,
    title: section.title,
    body: section.lines.join("\n").trim(),
  }));
}

module.exports = { parseSections };

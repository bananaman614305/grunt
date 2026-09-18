"use strict";
const assert = require("node:assert");
const { build } = require("./build.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const DOC = [
  "# Setup",
  "Read [[Notes]] before you start.",
  "",
  "## Notes",
  "Install the toolchain.",
  "",
  "## Advanced Usage!",
  "Nothing yet.",
  "",
  "## Notes",
  "Stray thoughts.",
].join("\n");

const OTHER = ["# Notes", "Another document entirely.", "", "## Notes", "Again."].join("\n");

function anchorsOf(html) {
  return [...html.matchAll(/<h\d id="([^"]*)"/g)].map((match) => match[1]);
}
function tocTargetsOf(html) {
  return [...html.matchAll(/\]\(#([^)]*)\)/g)].map((match) => match[1]);
}

check("repeated headings get numbered anchors in document order", () => {
  assert.deepStrictEqual(anchorsOf(build(DOC)), ["setup", "notes", "advanced-usage", "notes-2"]);
});

check("every table of contents entry points at its own section", () => {
  const html = build(DOC);
  assert.deepStrictEqual(tocTargetsOf(html), anchorsOf(html));
});

check("a cross-reference points at the first section with that title", () => {
  assert.ok(
    build(DOC).includes('<a href="#notes">Notes</a>'),
    "expected the [[Notes]] reference to link to #notes",
  );
});

check("building the same document twice gives the same output", () => {
  assert.strictEqual(build(DOC), build(DOC));
});

check("one document's headings do not affect the next document's anchors", () => {
  const first = build(DOC);
  build(OTHER);
  build(OTHER);
  assert.strictEqual(build(DOC), first);
  assert.deepStrictEqual(anchorsOf(build(OTHER)), ["notes", "notes-2"]);
});

process.exit(failed === 0 ? 0 : 1);

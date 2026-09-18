"use strict";
const assert = require("node:assert");
const { parseRow } = require("./csv.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("plain fields", () => {
  assert.deepStrictEqual(parseRow("a,b,c"), ["a", "b", "c"]);
});
check("quoted field keeps its comma", () => {
  assert.deepStrictEqual(parseRow('"hello, world",b'), ["hello, world", "b"]);
});
check("doubled quote inside a quoted field is a literal quote", () => {
  assert.deepStrictEqual(parseRow('"say ""hi""",x'), ['say "hi"', "x"]);
});
check("empty fields survive", () => {
  assert.deepStrictEqual(parseRow("a,,c"), ["a", "", "c"]);
});

process.exit(failed === 0 ? 0 : 1);

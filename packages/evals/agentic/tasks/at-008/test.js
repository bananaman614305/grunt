"use strict";
const assert = require("node:assert");
const { loadConfig } = require("./config.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("both toggles accept every on spelling", () => {
  for (const on of ["true", "yes", "1", "YES", " True "]) {
    assert.deepStrictEqual(loadConfig({ debug: on, verbose: on }), { debug: true, verbose: true }, on);
  }
});
check("anything else means off", () => {
  for (const off of ["", "0", "no", "false", undefined]) {
    assert.deepStrictEqual(loadConfig({ debug: off, verbose: off }), { debug: false, verbose: false }, String(off));
  }
});

process.exit(failed === 0 ? 0 : 1);

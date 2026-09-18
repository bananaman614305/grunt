"use strict";
const assert = require("node:assert");
const { parseConfig } = require("./parse.js");
const { validateConfig } = require("./validate.js");
const { loadConfig } = require("./load.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

// A complete config: a comment, a blank line, spaces around the "=", and no
// trailing newline after the final line.
const CONFIG = "# database\nhost = db.local\n\nuser = admin\nport = 5432";

check("a complete config loads with every key and value", () => {
  const config = loadConfig(CONFIG);
  assert.strictEqual(config.host, "db.local");
  assert.strictEqual(config.user, "admin");
  assert.strictEqual(config.port, "5432");
});

check("parsing keeps the last line", () => {
  assert.strictEqual(parseConfig(CONFIG).port, "5432");
});

check("a config that truly omits a required key is rejected", () => {
  assert.throws(() => validateConfig({ host: "db.local", user: "admin" }), {
    message: "missing required key: port",
  });
});

process.exit(failed === 0 ? 0 : 1);

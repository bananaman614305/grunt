"use strict";
const assert = require("node:assert");
const { merge } = require("./merge.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("nested objects merge instead of being replaced", () => {
  const base = { server: { host: "localhost", port: 80 }, name: "milo" };
  const out = merge(base, { server: { port: 8787 } });
  assert.deepStrictEqual(out, { server: { host: "localhost", port: 8787 }, name: "milo" });
});
check("arrays in the patch replace the base value", () => {
  assert.deepStrictEqual(merge({ tags: ["a", "b"] }, { tags: ["c"] }), { tags: ["c"] });
});
check("neither input is modified", () => {
  const base = { server: { port: 80 } };
  const patch = { server: { port: 8787 } };
  merge(base, patch);
  assert.strictEqual(base.server.port, 80);
  assert.strictEqual(patch.server.port, 8787);
});

process.exit(failed === 0 ? 0 : 1);

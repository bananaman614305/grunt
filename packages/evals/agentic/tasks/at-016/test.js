"use strict";
const assert = require("node:assert");
const { createKernel } = require("./kernel.js");
const { messageFor } = require("./codes.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const handler = (request) => ({ echo: request.body });
const small = (apiKey) => ({ apiKey, body: "hi" });
const huge = (apiKey) => ({ apiKey, body: "x".repeat(65) });

check("the existing chain still works", () => {
  const kernel = createKernel(handler);
  const accepted = kernel.handle(small("a"));
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(accepted.response.echo, "hi");
  assert.strictEqual(accepted.response.served, 1);
  assert.deepStrictEqual(kernel.handle(huge("a")), {
    ok: false,
    plugin: "size",
    error: { code: 1101, message: "request body too large (65 bytes)" },
  });
});

check("a key's fourth request is refused", () => {
  const kernel = createKernel(handler);
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(kernel.handle(small("a")).ok, true, "request " + (i + 1) + " should pass");
  }
  assert.deepStrictEqual(kernel.handle(small("a")), {
    ok: false,
    plugin: "quota",
    error: { code: 1301, message: "quota exceeded for key a" },
  });
  assert.strictEqual(kernel.handle(small("b")).ok, true, "another key is unaffected");
});

check("requests refused earlier in the chain do not count", () => {
  const kernel = createKernel(handler);
  kernel.handle(huge("a"));
  kernel.handle(huge("a"));
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(kernel.handle(small("a")).ok, true, "request " + (i + 1) + " should pass");
  }
  assert.strictEqual(kernel.handle(small("a")).ok, false);
});

check("tallies belong to one kernel and reset empties them", () => {
  const first = createKernel(handler);
  for (let i = 0; i < 3; i += 1) first.handle(small("a"));
  const second = createKernel(handler);
  assert.strictEqual(second.handle(small("a")).ok, true, "a fresh kernel starts at zero");
  assert.strictEqual(first.handle(small("a")).ok, false);
  first.reset();
  assert.strictEqual(first.handle(small("a")).ok, true);
});

check("the quota message comes from the shared table", () => {
  assert.strictEqual(messageFor(1301, "a"), "quota exceeded for key a");
});

process.exit(failed === 0 ? 0 : 1);

"use strict";
const assert = require("node:assert");
const { createBreaker } = require("./breaker.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

let clock = 0;
let invocations = 0;
const now = () => clock;
const good = () => { invocations += 1; return "value"; };
const bad = () => { invocations += 1; throw new Error("upstream down"); };
const fresh = () => createBreaker({ failureThreshold: 3, cooldownMs: 1000, now });

function expectThrows(breaker, fn, message) {
  assert.throws(() => breaker.call(fn), { message });
}
function expectRefused(breaker) {
  const before = invocations;
  assert.throws(() => breaker.call(good), { message: "circuit open" });
  assert.strictEqual(invocations, before, "a refused call must not invoke the function");
}
// Trip a closed breaker open.
function trip(breaker) {
  for (let i = 0; i < 3; i += 1) expectThrows(breaker, bad, "upstream down");
}

check("a closed breaker passes values and errors through", () => {
  const breaker = fresh();
  assert.strictEqual(breaker.call(good), "value");
  expectThrows(breaker, bad, "upstream down");
  assert.strictEqual(breaker.state, "closed");
});

check("only consecutive failures trip it", () => {
  const breaker = fresh();
  expectThrows(breaker, bad, "upstream down");
  expectThrows(breaker, bad, "upstream down");
  breaker.call(good);
  expectThrows(breaker, bad, "upstream down");
  expectThrows(breaker, bad, "upstream down");
  assert.strictEqual(breaker.state, "closed");
  expectThrows(breaker, bad, "upstream down");
  assert.strictEqual(breaker.state, "open");
});

check("an open breaker refuses until the cooldown has fully passed", () => {
  clock = 5000;
  const breaker = fresh();
  trip(breaker);
  expectRefused(breaker);
  clock = 5999;
  expectRefused(breaker);
  clock = 6000;
  let seen = null;
  breaker.call(() => { seen = breaker.state; return "value"; });
  assert.strictEqual(seen, "half_open", "the trial call runs with the breaker half open");
});

check("a successful trial closes the breaker and clears the count", () => {
  clock = 0;
  const breaker = fresh();
  trip(breaker);
  clock = 1000;
  assert.strictEqual(breaker.call(good), "value");
  assert.strictEqual(breaker.state, "closed");
  expectThrows(breaker, bad, "upstream down");
  expectThrows(breaker, bad, "upstream down");
  assert.strictEqual(breaker.state, "closed", "the earlier failures no longer count");
  expectThrows(breaker, bad, "upstream down");
  assert.strictEqual(breaker.state, "open");
});

check("a failed trial reopens the breaker and restarts the cooldown", () => {
  clock = 0;
  const breaker = fresh();
  trip(breaker);
  clock = 1000;
  expectThrows(breaker, bad, "upstream down");
  assert.strictEqual(breaker.state, "open");
  expectRefused(breaker);
  clock = 1999;
  expectRefused(breaker);
  clock = 2000;
  assert.strictEqual(breaker.call(good), "value");
  assert.strictEqual(breaker.state, "closed");
});

process.exit(failed === 0 ? 0 : 1);

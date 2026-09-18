"use strict";

// createBreaker({ failureThreshold, cooldownMs, now }) guards a synchronous
// call. `now` is the caller's clock, in milliseconds.
function createBreaker(options) {
  const { failureThreshold, cooldownMs, now } = options;
  let state = "closed";
  let failures = 0;
  let openedAt = 0;

  function call(fn) {
    if (state === "open") {
      if (now() - openedAt <= cooldownMs) throw new Error("circuit open");
      state = "half_open";
      failures = 0;
    }
    try {
      const value = fn();
      failures = 0;
      return value;
    } catch (err) {
      failures += 1;
      if (failures >= failureThreshold) {
        state = "open";
        openedAt = now();
      }
      throw err;
    }
  }

  return {
    call,
    get state() {
      return state;
    },
  };
}

module.exports = { createBreaker };

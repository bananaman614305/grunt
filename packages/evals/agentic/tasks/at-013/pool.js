"use strict";

// createPool(limit) runs at most `limit` jobs at a time. run(fn) queues fn and
// returns a promise for its result; queued jobs start in submission order.
function createPool(limit) {
  let active = 0;
  const queue = [];

  function pump() {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      job.fn().then((value) => {
        active -= 1;
        job.resolve(value);
        pump();
      });
    }
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }

  // onIdle() -> a promise that settles when the pool has nothing left to do.
  function onIdle() {
    throw new Error("not implemented");
  }

  return { run, onIdle };
}

module.exports = { createPool };

"use strict";

// memoize(fn) returns a wrapper that remembers what `fn` returned for a call
// so the expensive work behind it happens once.
function memoize(fn) {
  const cache = new Map();
  return function memoized(...args) {
    const key = String(args[0]);
    if (cache.has(key)) return cache.get(key);
    const value = fn(...args);
    cache.set(key, value);
    return value;
  };
}

module.exports = { memoize };

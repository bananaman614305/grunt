"use strict";

// A minimal LIFO stack.
class Stack {
  constructor() {
    this.items = [];
  }
  push(value) {
    this.items.push(value);
    return this;
  }
  pop() {
    if (this.items.length === 0) throw new RangeError("pop from empty stack");
    return this.items.pop();
  }
  get size() {
    return this.items.length;
  }
}

module.exports = { Stack };

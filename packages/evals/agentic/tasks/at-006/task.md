# Add peek and isEmpty to Stack

`stack.js` has push, pop, and size, but callers keep popping just to look at
the top. Add `peek()`, returning the top value without removing it and
throwing a `RangeError` on an empty stack (like `pop` does), and
`isEmpty()`, returning whether the stack has no items. `node test.js`
checks the result.

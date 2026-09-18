# Make the row summary live

`aggregate.js` summarizes a whole list of rows at once, which is all we had
when rows arrived in batches; now they arrive and disappear one at a time and
recomputing everything each time is too slow. Implement `createSummary()` in
`incremental.js`, returning `{ add(row), remove(row), snapshot() }`, so that:

1. `snapshot()` always deep-equals `summarize(rows)` for exactly the rows held
   at that moment, including when nothing is held at all.
2. `remove(row)` drops the held row with that row's `id`; removing an `id` that
   is not held throws `Error("unknown row: <id>")`, and adding an `id` that is
   already held throws `Error("duplicate row: <id>")`.
3. A group whose last row is removed disappears from the summary, and comes
   back correctly if a row of that group is added again.
4. `snapshot()` hands back a fresh structure every time: whatever the caller
   does to one must not show up in the next one, or in the summary.
5. `add`, `remove` and `snapshot` must do work that grows with the number of
   groups, not with the number of rows held — the test calls them tens of
   thousands of times and fails if they cannot keep up.

`node test.js` checks the result.

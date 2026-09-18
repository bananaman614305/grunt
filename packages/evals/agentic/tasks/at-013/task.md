# Make the job pool survive failures and report when it is idle

`pool.js` runs at most `limit` jobs at a time, but it only copes with jobs
that succeed: a job that fails takes its slot with it, so the jobs behind it
never start and the caller's promise never settles. Make `run(fn)` reject with
whatever the job threw or rejected with — including a function that throws
before returning a promise — while the slot is released and the next queued
job starts, in submission order, with never more than `limit` jobs in flight.
Then implement `onIdle()`: it returns a promise that resolves once no job is
running and none is queued, it must also wait for jobs that were submitted
after it was called but before it resolved, and on a pool with nothing to do
it resolves anyway. `node test.js` checks the result.

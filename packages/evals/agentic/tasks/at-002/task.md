# Fix median

`stats.js` computes the median of a list of numbers, but it gives wrong
answers for lists mixing numbers of different digit counts and for
even-length lists. The median of an even-length list is the mean of the two
middle values after sorting numerically. Fix `median` without modifying the
caller's array; `node test.js` checks the result.

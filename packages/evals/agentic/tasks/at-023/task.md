# Split an amount into even whole-cent shares

`split.js` exports `splitAmount(totalCents, n)`, which divides a whole number
of cents among `n` recipients and returns an array of `n` whole-cent shares.
The result must satisfy both rules together: the shares add up to exactly
`totalCents`, and they are as even as possible, so no two shares differ by more
than one cent. For example, 101 cents among 3 recipients is `[34, 34, 33]`.
Right now it does not always hold to both rules. Fix it. `node test.js` checks
the result.

# Fix the ledger balance

`ledger.js` tracks money in whole cents. Each entry is a `credit` or a `debit`;
a credit adds to the running balance and a debit subtracts from it. `running`
returns the balance after each entry, `balance` returns the final one, and
`format` renders a cent amount as a dollar string like `"$1.50"` or
`"-$1.50"`. After a debit takes the balance below zero, the reported balance
comes out positive instead of negative. Make the balance reflect debits.
`node test.js` checks the result.

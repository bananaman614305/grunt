# Fix the ordinal suffixes

`ordinal.js` turns a positive whole number into its English ordinal, like
`1 -> "1st"`, `2 -> "2nd"`, `3 -> "3rd"`, `4 -> "4th"`, `22 -> "22nd"`. Some
numbers come out with the wrong suffix. Make `ordinal(n)` correct for every
positive whole number. `node test.js` checks the result.

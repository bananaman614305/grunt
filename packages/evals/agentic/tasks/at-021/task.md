# Fix the booking day arithmetic

`stay.js` does two kinds of day-number arithmetic. `nightsBetween(checkIn,
checkOut)` returns how many nights a guest sleeps: a guest in on day 2 and out
on day 5 sleeps three nights (days 2, 3 and 4). `blockedDays(from, to)` returns
the list of day numbers a maintenance block reserves, counting both ends:
blocking day 2 through day 5 reserves days 2, 3, 4 and 5. One of them is off.
Make both correct at once. `node test.js` checks the result.

# Implement the cron expression matcher

`cron.js` exports a stub for `matches(expression, date)`, which answers whether
a five-field cron expression fires at a given `Date`. It must follow all of
these rules:

1. The five fields, in order, are minute (0-59), hour (0-23), day of month
   (1-31), month (1-12) and day of week (0-6, where 0 is Sunday), separated by
   runs of whitespace. Every field must match, subject to rule 6. The date is
   read in UTC, and its seconds are ignored.
2. A field is a comma-separated list of items, and an item is `*`, a single
   value, or an inclusive range `a-b`.
3. Any item may carry a step: `*/n` is every nth value from the field's
   minimum, `a-b/n` every nth from `a` through `b`, and `a/n` every nth from
   `a` through the field's maximum.
4. Months may be written `JAN` through `DEC` and days of the week `SUN`
   through `SAT`, in any case, anywhere a number is allowed, the ends of a
   range included.
5. In the day-of-week field `7` means Sunday as well.
6. A field counts as restricted when it is anything other than `*`. If the day
   of month and the day of week are both restricted, the date matches when
   either of them matches; if only one of the two is restricted, only that one
   has a say.
7. Anything else — the wrong number of fields, a value outside its field's
   range, a step below 1, an item that parses as none of the above — throws
   `Error("invalid cron expression: <expression>")`, quoting the expression as
   it was given.

`node test.js` checks the result.

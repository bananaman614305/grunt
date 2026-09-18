# Support quoted CSV fields

`csv.js` splits a CSV row on commas, which breaks on quoted fields. Extend
`parseRow` to handle double-quoted fields: a quoted field may contain commas,
the surrounding quotes are not part of the value, and a doubled quote inside
a quoted field means one literal quote character. Unquoted fields keep
working as before. `node test.js` checks the result.

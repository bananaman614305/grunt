# Fix the warehouse stock counts

`warehouse.js` keeps whole-unit counts per SKU, and SKUs are meant to be
case-insensitive: `"Widget"` and `"widget"` are the same item. But after
adding stock under one spelling, `reserve` refuses the item with `insufficient
stock for Widget` even though plenty was added, and `stock` reports zero for
it. Reserving genuinely more than is on hand must still throw. Make the counts
consistent however a SKU is capitalized. `node test.js` checks the result.

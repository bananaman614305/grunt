# Fix the box-count arithmetic

`packing.js` packs whole items into boxes that hold `perBox` items each.
`boxesNeeded(items, perBox)` is how many boxes it takes to hold every item, so
a box that is only partly full still counts: 10 items at 4 per box need 3
boxes. `fullBoxes(items, perBox)` is how many boxes come out completely full:
10 items at 4 per box give 2 full boxes. Right now they do not both give the
right answer. Make both correct. `node test.js` checks the result.

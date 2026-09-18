"use strict";

// Packing whole items into fixed-capacity boxes, `perBox` items per box.
//
//   boxesNeeded(items, perBox): how many boxes are needed to hold every item.
//     A box that is only partly full still counts. 10 items at 4 per box need
//     3 boxes.
//   fullBoxes(items, perBox): how many boxes come out completely full. 10
//     items at 4 per box give 2 full boxes (the third holds only 2).
//
// `items` and `perBox` are positive whole numbers; `items` may be zero.

function divide(items, perBox) {
  return Math.floor(items / perBox);
}

function boxesNeeded(items, perBox) {
  return divide(items, perBox);
}

function fullBoxes(items, perBox) {
  return divide(items, perBox);
}

module.exports = { boxesNeeded, fullBoxes };

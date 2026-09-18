"use strict";

// summarize(rows) over rows of { id, group, amount }, where every amount is a
// whole number, returns { groups, total }: one { count, sum, min, max, mean }
// per group that has rows, and the same five over every row. With no rows at
// all, `groups` is empty and the total's min, max and mean are null.
function summarize(rows) {
  const groups = {};
  for (const row of rows) {
    const bucket = groups[row.group] ?? { count: 0, sum: 0, min: row.amount, max: row.amount, mean: 0 };
    bucket.count += 1;
    bucket.sum += row.amount;
    bucket.min = Math.min(bucket.min, row.amount);
    bucket.max = Math.max(bucket.max, row.amount);
    groups[row.group] = bucket;
  }
  const total = { count: 0, sum: 0, min: null, max: null, mean: null };
  for (const bucket of Object.values(groups)) {
    bucket.mean = bucket.sum / bucket.count;
    total.count += bucket.count;
    total.sum += bucket.sum;
    total.min = total.min === null ? bucket.min : Math.min(total.min, bucket.min);
    total.max = total.max === null ? bucket.max : Math.max(total.max, bucket.max);
  }
  if (total.count > 0) total.mean = total.sum / total.count;
  return { groups, total };
}

module.exports = { summarize };

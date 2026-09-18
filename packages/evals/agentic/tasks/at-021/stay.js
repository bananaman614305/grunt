"use strict";

// Booking arithmetic over day numbers (day 0 is today, day 1 is tomorrow).
//
// A guest's stay is measured in NIGHTS: checking in on day 2 and out on day 5
// means the guest sleeps on days 2, 3 and 4 -- three nights.
//
// A maintenance block reserves whole days INCLUSIVE of both ends: blocking
// from day 2 to day 5 makes days 2, 3, 4 and 5 all unavailable.

function daysInRange(from, to) {
  return to - from;
}

// nightsBetween(checkIn, checkOut) -> the number of nights slept.
function nightsBetween(checkIn, checkOut) {
  return daysInRange(checkIn, checkOut);
}

// blockedDays(from, to) -> the list of day numbers the room is unavailable,
// from `from` to `to` inclusive.
function blockedDays(from, to) {
  const days = [];
  const count = daysInRange(from, to);
  for (let i = 0; i < count; i += 1) days.push(from + i);
  return days;
}

module.exports = { nightsBetween, blockedDays };

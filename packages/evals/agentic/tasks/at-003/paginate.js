"use strict";

// Return the items on 1-based `page`, `perPage` at a time, plus paging info.
function paginate(items, page, perPage) {
  const start = page * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    totalPages: Math.floor(items.length / perPage),
  };
}

module.exports = { paginate };

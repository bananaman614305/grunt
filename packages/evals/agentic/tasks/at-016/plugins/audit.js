"use strict";

// Counts the requests that reach it and tells the caller how many this kernel
// has served. The tally belongs to one kernel, so it is born in `create()` and
// emptied by `reset()`.
module.exports = {
  name: "audit",
  priority: 90,
  create() {
    let served = [];
    return {
      onRequest(ctx) {
        served.push(ctx.request.apiKey);
        return undefined;
      },
      onResponse(ctx, response) {
        return { ...response, served: served.length };
      },
      reset() {
        served = [];
      },
    };
  },
};

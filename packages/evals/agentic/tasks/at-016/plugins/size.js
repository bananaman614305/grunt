"use strict";

const { codeFor } = require("../codes.js");

const LIMIT = 64;

// Refuses request bodies over the limit. Holds no state, so it needs no reset.
module.exports = {
  name: "size",
  priority: 10,
  create() {
    return {
      onRequest(ctx) {
        const size = String(ctx.request.body ?? "").length;
        if (size > LIMIT) return ctx.reject(codeFor("size", 1), size);
        return undefined;
      },
    };
  },
};

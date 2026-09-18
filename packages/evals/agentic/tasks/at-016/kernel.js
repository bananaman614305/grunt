"use strict";

const { plugins } = require("./manifest.js");
const { messageFor } = require("./codes.js");

// createKernel(handler) wires up every plugin in the manifest. A request
// passes the plugins in ascending `priority` order and the response comes back
// through them in descending order.
function createKernel(handler) {
  const loaded = [...plugins].sort((left, right) => left.priority - right.priority);
  for (let i = 1; i < loaded.length; i += 1) {
    if (loaded[i].priority === loaded[i - 1].priority) {
      throw new Error("duplicate plugin priority: " + loaded[i].priority);
    }
  }
  const chain = loaded.map((plugin) => ({ name: plugin.name, instance: plugin.create() }));

  function handle(request) {
    const ctx = {
      request,
      // How a plugin refuses a request. Plugins return this; they do not throw.
      reject(code, ...args) {
        return { rejected: true, code, message: messageFor(code, ...args) };
      },
    };

    for (const { name, instance } of chain) {
      if (typeof instance.onRequest !== "function") continue;
      const outcome = instance.onRequest(ctx);
      if (outcome !== undefined && outcome !== null && outcome.rejected === true) {
        return { ok: false, plugin: name, error: { code: outcome.code, message: outcome.message } };
      }
    }

    if (typeof handler !== "function") {
      return { ok: false, plugin: "core", error: { code: 1001, message: messageFor(1001) } };
    }

    let response = handler(request);
    for (const { instance } of [...chain].reverse()) {
      if (typeof instance.onResponse === "function") response = instance.onResponse(ctx, response);
    }
    return { ok: true, response };
  }

  // Puts every plugin's per-kernel state back to how it started.
  function reset() {
    for (const { instance } of chain) {
      if (typeof instance.reset === "function") instance.reset();
    }
  }

  return { handle, reset };
}

module.exports = { createKernel };

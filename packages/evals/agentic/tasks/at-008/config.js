"use strict";

// Read feature toggles out of a raw string map (e.g. parsed environment
// variables). "true", "yes", and "1" -- any letter case -- all mean on;
// anything else means off.
function loadConfig(raw) {
  const debugValue = (raw.debug || "").trim().toLowerCase();
  const debug = debugValue === "true" || debugValue === "yes" || debugValue === "1";

  const verboseValue = (raw.verbose || "").trim().toLowerCase();
  const verbose = verboseValue === "true";

  return { debug, verbose };
}

module.exports = { loadConfig };

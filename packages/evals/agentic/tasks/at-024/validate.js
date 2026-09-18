"use strict";

// The keys every config must define.
const REQUIRED = ["host", "user", "port"];

// validateConfig(config) throws if a required key is missing, naming the first
// one it finds absent; otherwise it returns the config unchanged.
function validateConfig(config) {
  for (const key of REQUIRED) {
    if (!(key in config)) throw new Error("missing required key: " + key);
  }
  return config;
}

module.exports = { validateConfig, REQUIRED };

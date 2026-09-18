"use strict";

// parseConfig(text) reads a config file of "key = value" lines into an object.
// Blank lines and lines starting with "#" are comments and are skipped. A key
// or value may have surrounding spaces, which are trimmed.
function parseConfig(text) {
  const lines = text.split("\n");
  const config = {};
  // The file ends with a trailing newline, so the final piece of the split is
  // an empty string; stop before it.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    config[key] = value;
  }
  return config;
}

module.exports = { parseConfig };
